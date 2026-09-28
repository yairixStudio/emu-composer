// simbridge — a booted iOS simulator's screen and touch, straight from CoreSimulator.
//
// The screen: the simulator's own framebuffer (an IOSurface the render server draws into),
// with a callback per presented frame — nothing is polled, and a still screen sends nothing.
// Each frame is scaled on the GPU and encoded by VideoToolbox as low-latency H.264.
// The touch: the guest's `dtuhidd` digitizer service over XPC — start / position / end
// contacts, so a drag is a real drag (scroll views keep their momentum), not a replayed swipe.
//
// This is the approach of Meta's idb (FBSimulatorControl, MIT) — see LICENSE-idb.txt — cut down
// to what emu-composer needs and written against the ObjC runtime so it builds with plain clang.
//
// Protocol. stdin, one command per line:
//   s <width> <fps>         start video at that width (even; capped to the screen's)
//   x                       stop video
//   k                       key frame now (a page joined)
//   j <width> <quality>     one JPEG of the screen now
//   d|m|u <x> <y> [edge]    touch down / move / up; x and y are 0..1 of the screen, top-left.
//                           edge (on d): 1 top, 2 left, 3 bottom, 4 right — the guest reads the
//                           system gestures (back, home, switcher) from it, not from the position
//   t <x> <y>               tap
//   w <x1> <y1> <x2> <y2> <ms> [edge]   swipe
//   b home|lock|siri|volup|voldown   press a hardware button
//   K <usage>               press a keyboard key (USB HID usage, e.g. 0x28 Return)
// stdout, one message after another: u32 big-endian length, then one kind byte, then the body.
//   'v' an H.264 access unit, Annex-B (SPS and PPS before every IDR)
//   'j' a JPEG            'i' a JSON line of state         'e' a JSON line of error
// Logs go to stderr. The helper exits when stdin closes or the simulator shuts down.

#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <CoreImage/CoreImage.h>
#import <CoreVideo/CoreVideo.h>
#import <VideoToolbox/VideoToolbox.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <xpc/xpc.h>
#import <signal.h>

static const char *DIGITIZER = "com.apple.coredevice.feature.remote.hid.digitizer";

static id call0(id o, const char *sel) { return ((id(*)(id, SEL))objc_msgSend)(o, sel_registerName(sel)); }
static double now(void) { return CFAbsoluteTimeGetCurrent(); }

// ------------------------------------------------------------------ output ---
static dispatch_queue_t outQ;
static void emit(char kind, const void *bytes, size_t len) {
  NSData *copy = [NSData dataWithBytes:bytes length:len];
  dispatch_async(outQ, ^{
    uint8_t head[5] = { (uint8_t)(copy.length >> 24), (uint8_t)(copy.length >> 16), (uint8_t)(copy.length >> 8), (uint8_t)copy.length, (uint8_t)kind };
    fwrite(head, 1, 5, stdout); fwrite(copy.bytes, 1, copy.length, stdout); fflush(stdout);
  });
}
static void emitJSON(char kind, NSDictionary *d) {
  NSData *j = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  emit(kind, j.bytes, j.length);
}
static void fail(NSString *what) { emitJSON('e', @{ @"error": what }); fprintf(stderr, "simbridge: %s\n", what.UTF8String); }

// ------------------------------------------------------------------ device ---
static id device;
static id findDevice(NSString *udid, NSString *developerDir) {
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) return nil;
  NSError *err = nil;
  id ctx = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(NSClassFromString(@"SimServiceContext"), sel_registerName("sharedServiceContextForDeveloperDir:error:"), developerDir, &err);
  id set = ctx ? ((id(*)(id, SEL, NSError **))objc_msgSend)(ctx, sel_registerName("defaultDeviceSetWithError:"), &err) : nil;
  for (id d in call0(set, "devices")) if ([[call0(d, "UDID") UUIDString] caseInsensitiveCompare:udid] == NSOrderedSame) return d;
  return nil;
}
static unsigned long deviceState(void) { return ((unsigned long(*)(id, SEL))objc_msgSend)(device, sel_registerName("state")); }

// The port whose descriptor is the main screen (display class 0) and vends the new-style
// SimScreen callbacks. Every call on a descriptor goes through a ROCK proxy and can raise.
static SEL REGISTER;
static id findScreen(void) {
  id fallback = nil;
  for (id port in call0(call0(device, "io"), "ioPorts")) {
    id desc = nil;
    @try { desc = call0(port, "descriptor"); } @catch (id e) { continue; }
    if (![desc respondsToSelector:REGISTER]) continue;
    unsigned cls = 99;
    @try { cls = ((unsigned(*)(id, SEL))objc_msgSend)(call0(desc, "state"), sel_registerName("displayClass")); } @catch (id e) {}
    if (cls == 0) return desc;
    if (!fallback) fallback = desc;
  }
  return fallback;
}

// ------------------------------------------------------------------ screen ---
static dispatch_queue_t encQ;          // everything below runs on it
static IOSurfaceRef surface;           // the framebuffer the render server draws into
static VTCompressionSessionRef session;
static VTPixelTransferSessionRef transfer;
static int outW, outH, fps = 60;
static BOOL streaming, pendingKey;
static double lastEncode;
static uint64_t frameNo, framesSeen;
static dispatch_source_t tick;         // coalesces frame callbacks

static void appendAnnexB(NSMutableData *out, const uint8_t *p, size_t n) {
  static const uint8_t sc[4] = { 0, 0, 0, 1 };
  [out appendBytes:sc length:4]; [out appendBytes:p length:n];
}
static void encoded(void *ref, void *src, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sb) {
  if (status != noErr || !sb || !CMSampleBufferDataIsReady(sb)) return;
  CFArrayRef att = CMSampleBufferGetSampleAttachmentsArray(sb, false);
  BOOL key = !(att && CFArrayGetCount(att) && CFDictionaryContainsKey(CFArrayGetValueAtIndex(att, 0), kCMSampleAttachmentKey_NotSync));
  NSMutableData *au = [NSMutableData data];
  if (key) {
    CMFormatDescriptionRef fd = CMSampleBufferGetFormatDescription(sb);
    size_t count = 0; CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, 0, NULL, NULL, &count, NULL);
    for (size_t i = 0; i < count; i++) {
      const uint8_t *ps; size_t psLen;
      if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, i, &ps, &psLen, NULL, NULL) == noErr) appendAnnexB(au, ps, psLen);
    }
  }
  CMBlockBufferRef bb = CMSampleBufferGetDataBuffer(sb);
  size_t total = 0; char *base = NULL;
  if (CMBlockBufferGetDataPointer(bb, 0, NULL, &total, &base) != noErr) return;
  for (size_t off = 0; off + 4 <= total;) {    // AVCC: 4-byte big-endian lengths
    uint32_t n = CFSwapInt32BigToHost(*(uint32_t *)(base + off));
    if (off + 4 + n > total) break;
    appendAnnexB(au, (uint8_t *)base + off + 4, n);
    off += 4 + n;
  }
  emit('v', au.bytes, au.length);
}
static void closeSession(void) {
  if (session) { VTCompressionSessionCompleteFrames(session, kCMTimeInvalid); VTCompressionSessionInvalidate(session); CFRelease(session); session = NULL; }
}
static BOOL openSession(void) {
  closeSession();
  NSDictionary *spec = @{ (id)kVTVideoEncoderSpecification_EnableLowLatencyRateControl: @YES };
  NSDictionary *srcAttrs = @{ (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
                              (id)kCVPixelBufferWidthKey: @(outW), (id)kCVPixelBufferHeightKey: @(outH),
                              (id)kCVPixelBufferIOSurfacePropertiesKey: @{} };
  OSStatus st = VTCompressionSessionCreate(NULL, outW, outH, kCMVideoCodecType_H264, (__bridge CFDictionaryRef)spec,
                                           (__bridge CFDictionaryRef)srcAttrs, NULL, encoded, NULL, &session);
  if (st != noErr) { fail([NSString stringWithFormat:@"VTCompressionSessionCreate %d", (int)st]); return NO; }
  VTSessionSetProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, (__bridge CFTypeRef)@(100000));
  VTSessionSetProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFTypeRef)@(fps));
  // Plenty for a loopback socket, so text stays readable while a list scrolls; low-latency rate
  // control spends it per frame, and a starved budget turned the last frame of a transition to blocks.
  VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFTypeRef)@(MAX(8000000, outW * outH * fps / 3)));
  VTCompressionSessionPrepareToEncodeFrames(session);
  return YES;
}
static void encodeNow(BOOL forceKey) {
  if (!streaming || !surface) return;
  if (!session && !openSession()) return;
  CVPixelBufferRef src = NULL, dst = NULL;
  if (CVPixelBufferCreateWithIOSurface(NULL, surface, NULL, &src) != kCVReturnSuccess) return;
  CVPixelBufferPoolRef pool = VTCompressionSessionGetPixelBufferPool(session);
  if (!pool || CVPixelBufferPoolCreatePixelBuffer(NULL, pool, &dst) != kCVReturnSuccess) { CVPixelBufferRelease(src); return; }
  if (!transfer) VTPixelTransferSessionCreate(NULL, &transfer);
  OSStatus st = VTPixelTransferSessionTransferImage(transfer, src, dst);   // GPU scale + BGRA→YUV
  CVPixelBufferRelease(src);
  if (st != noErr) { CVPixelBufferRelease(dst); return; }
  NSDictionary *props = forceKey ? @{ (id)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES } : nil;
  VTCompressionSessionEncodeFrame(session, dst, CMTimeMake((int64_t)frameNo++, 600), kCMTimeInvalid, (__bridge CFDictionaryRef)props, NULL, NULL);
  CVPixelBufferRelease(dst);
  lastEncode = now();
}
// A frame was presented: encode it, at most `fps` times a second (the last one always lands).
static void onFrame(void) {
  if (!streaming) return;
  double wait = lastEncode + 1.0 / fps - now();
  if (wait > 0.001) { dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)), encQ, ^{ if (lastEncode + 1.0 / fps <= now() + 0.0005) onFrame(); }); return; }
  encodeNow(pendingKey); pendingKey = NO;
}
static void startVideo(int width, int rate) {
  if (!surface) { fail(@"no framebuffer yet"); return; }
  int W = (int)IOSurfaceGetWidth(surface), H = (int)IOSurfaceGetHeight(surface);
  int w = MIN(W, MAX(240, width)) & ~1, h = ((int)lround((double)w * H / W)) & ~1;
  fps = MAX(10, MIN(120, rate));
  if (w != outW || h != outH) { outW = w; outH = h; closeSession(); }
  streaming = YES; pendingKey = YES; lastEncode = 0;
  encodeNow(YES); pendingKey = NO;   // the screen may be still: the first picture must not wait for a change
  emitJSON('i', @{ @"video": @YES, @"w": @(outW), @"h": @(outH), @"fps": @(fps) });
}
static void stopVideo(void) { streaming = NO; closeSession(); }

static CIContext *ciContext;
static void jpeg(int width, double quality) {
  if (!surface) { fail(@"no framebuffer yet"); return; }
  CIImage *img = [CIImage imageWithIOSurface:surface];
  double k = width > 0 ? MIN(1.0, width / img.extent.size.width) : 1.0;
  if (k < 1) img = [img imageByApplyingTransform:CGAffineTransformMakeScale(k, k)];
  if (!ciContext) ciContext = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  NSData *d = [ciContext JPEGRepresentationOfImage:img colorSpace:cs options:@{ (id)kCGImageDestinationLossyCompressionQuality: @(quality) }];
  CGColorSpaceRelease(cs);
  if (d) emit('j', d.bytes, d.length); else fail(@"jpeg failed");
}

static BOOL watchScreen(void) {
  REGISTER = sel_registerName("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:");
  id screen = findScreen();
  if (!screen) { fail(@"the simulator has no screen port (is it booted?)"); return NO; }
  // The render server calls these synchronously on its own thread: signal and return.
  dispatch_queue_t cbQ = dispatch_queue_create("simbridge.callbacks", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
  void (^frame)(void) = ^{ framesSeen++; dispatch_source_merge_data(tick, 1); };
  void (^surfaces)(id, id) = ^(id fb, id masked) {
    IOSurfaceRef s = (__bridge IOSurfaceRef)fb;
    if (s) CFRetain(s);
    dispatch_async(encQ, ^{
      if (surface) CFRelease(surface);
      surface = s;
      if (!s) return;
      emitJSON('i', @{ @"screen": @{ @"w": @(IOSurfaceGetWidth(s)), @"h": @(IOSurfaceGetHeight(s)) } });
      if (streaming) startVideo(outW, fps);   // a rotation or resize: new dimensions, new session
    });
  };
  void (^props)(id) = ^(id p) {};
  @try {
    ((void(*)(id, SEL, id, id, id, id, id))objc_msgSend)(screen, REGISTER, [NSUUID UUID], cbQ, frame, surfaces, props);
  } @catch (NSException *e) { fail([NSString stringWithFormat:@"screen callbacks: %@", e.reason]); return NO; }
  // The surface callback fires on registration on current CoreSimulator; read it directly too.
  id fb = nil;
  @try { fb = call0(screen, "framebufferSurface"); } @catch (id e) {}
  if (fb) { IOSurfaceRef s = (__bridge IOSurfaceRef)fb; CFRetain(s); dispatch_async(encQ, ^{ if (!surface) { surface = s; emitJSON('i', @{ @"screen": @{ @"w": @(IOSurfaceGetWidth(s)), @"h": @(IOSurfaceGetHeight(s)) } }); } else CFRelease(s); }); }
  return YES;
}

// ------------------------------------------------------------------- touch ---
static dispatch_queue_t hidQ;
static xpc_connection_t hid;
static BOOL hidReady;
static uint64_t edge;                  // of the contact in progress
static double touchDownAt;

static xpc_object_t hidMessage(const char *type, xpc_object_t payload, bool barrier) {
  xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(m, "messageType", type);
  xpc_dictionary_set_bool(m, "isBarrier", barrier);
  xpc_dictionary_set_string(m, "featureIdentifier", DIGITIZER);
  xpc_dictionary_set_value(m, "payload", payload);
  return m;
}
// dtuhidd decodes these with Codable: every number is a uint64, the point a pair of doubles.
static void sendTouch(double x, double y, uint64_t phase) {   // 0 start, 1 position, 2 end
  if (!hid) return;
  xpc_object_t pt = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(pt, "x", MAX(0, MIN(1, x))); xpc_dictionary_set_double(pt, "y", MAX(0, MIN(1, y)));
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(p, "pointOne", pt);
  xpc_dictionary_set_uint64(p, "eventType", phase);
  xpc_dictionary_set_uint64(p, "edge", edge);
  xpc_dictionary_set_uint64(p, "target", 0);
  xpc_connection_send_message(hid, hidMessage("IndigoDigitizerEvent", p, false));
}
static void sendButton(uint64_t page, uint64_t code, uint64_t state) {   // state: 1 down, 2 up
  if (!hid) return;
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usagePage", page); xpc_dictionary_set_uint64(p, "usageCode", code); xpc_dictionary_set_uint64(p, "state", state);
  xpc_connection_send_message(hid, hidMessage("IndigoButtonEvent", p, false));
}
static void sendKey(uint64_t usage, uint64_t state) {
  if (!hid) return;
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usageCode", usage); xpc_dictionary_set_uint64(p, "state", state);
  xpc_connection_send_message(hid, hidMessage("IndigoKeyboardButtonEvent", p, false));
}

// The service is looked up inside the guest, then its port turned into a host→guest XPC
// connection with libxpc's `_4sim` entry points. dtuhidd is demand-launched and can crash
// while the boot is still settling, so a barrier must come back before anything is sent.
static void connectHid(int attempt) {
  NSError *err = nil;
  mach_port_t port = ((mach_port_t(*)(id, SEL, id, NSError **))objc_msgSend)(device, sel_registerName("lookup:error:"), @(DIGITIZER), &err);
  xpc_object_t (*endpointFromPort)(mach_port_t, uint64_t, uint64_t) = dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  void (*sim2host)(xpc_connection_t) = dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (!port || !endpointFromPort || !sim2host) {
    fail(port ? @"libxpc has no simulator endpoints" : [NSString stringWithFormat:@"no touch service in the simulator: %@", err.localizedDescription ?: @"lookup failed"]);
    return;
  }
  xpc_connection_t c = xpc_connection_create_from_endpoint(endpointFromPort(port, 0, 0));
  sim2host(c);
  xpc_connection_set_target_queue(c, hidQ);
  xpc_connection_set_event_handler(c, ^(xpc_object_t e) {
    if (e == XPC_ERROR_CONNECTION_INTERRUPTED) fprintf(stderr, "simbridge: touch service interrupted\n");
  });
  xpc_connection_activate(c);
  xpc_object_t probe = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(probe, "usageCode", 0); xpc_dictionary_set_uint64(probe, "state", 2);   // "no key", up
  __block BOOL answered = NO;
  double t0 = now();
  xpc_connection_send_message_with_reply(c, hidMessage("IndigoKeyboardButtonEvent", probe, true), hidQ, ^(xpc_object_t r) {
    if (answered) return;
    answered = YES;
    if (xpc_get_type(r) != XPC_TYPE_ERROR) {
      hid = c; hidReady = YES;
      emitJSON('i', @{ @"touch": @"dtuhid", @"ms": @((int)((now() - t0) * 1000)) });
      return;
    }
    xpc_connection_cancel(c);
    if (attempt < 5) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC), hidQ, ^{ connectHid(attempt + 1); });
    else fail(@"the simulator's touch service does not answer");
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC), hidQ, ^{
    if (answered) return;
    answered = YES; xpc_connection_cancel(c);
    if (attempt < 5) connectHid(attempt + 1); else fail(@"the simulator's touch service does not answer");
  });
}

// ---------------------------------------------------------------- commands ---
static void command(char *line) {
  char op[8] = {0}; double a = 0, b = 0, c = 0, d = 0, e = 0; char word[32] = {0};
  if (sscanf(line, "%7s", op) != 1) return;
  switch (op[0]) {
    case 's': sscanf(line + 1, "%lf %lf", &a, &b); dispatch_async(encQ, ^{ startVideo((int)a, b > 0 ? (int)b : 60); }); break;
    case 'x': dispatch_async(encQ, ^{ stopVideo(); }); break;
    case 'k': dispatch_async(encQ, ^{ encodeNow(YES); }); break;
    case 'j': sscanf(line + 1, "%lf %lf", &a, &b); dispatch_async(encQ, ^{ jpeg((int)a, b > 0 ? b : 0.8); }); break;
    case 'd': case 'm': case 'u': {
      sscanf(line + 1, "%lf %lf %lf", &a, &b, &c);
      uint64_t phase = op[0] == 'd' ? 0 : op[0] == 'm' ? 1 : 2;
      dispatch_async(hidQ, ^{
        if (phase == 0) { edge = (uint64_t)c; touchDownAt = now(); }
        // A click can come up in the same millisecond it went down; the guest drops a contact
        // that short, so every touch lasts at least 40 ms.
        if (phase == 2) { double held = now() - touchDownAt; if (held < 0.04) usleep((useconds_t)((0.04 - held) * 1e6)); }
        sendTouch(a, b, phase);
      });
      break;
    }
    case 't': sscanf(line + 1, "%lf %lf", &a, &b);
      dispatch_async(hidQ, ^{ edge = 0; sendTouch(a, b, 0); usleep(45000); sendTouch(a, b, 2); }); break;
    case 'w': { double f = 0; sscanf(line + 1, "%lf %lf %lf %lf %lf %lf", &a, &b, &c, &d, &e, &f);
      dispatch_async(hidQ, ^{
        edge = (uint64_t)f;
        int steps = MAX(2, (int)(MAX(40, e) / 8));
        sendTouch(a, b, 0);
        for (int i = 1; i <= steps; i++) { usleep(8000); sendTouch(a + (c - a) * i / steps, b + (d - b) * i / steps, 1); }
        sendTouch(c, d, 2);
      }); break; }
    case 'b': {
      sscanf(line + 1, "%31s", word);
      uint64_t code = !strcmp(word, "home") ? 0x40 : !strcmp(word, "lock") ? 0x30 : !strcmp(word, "siri") ? 0xCF
                    : !strcmp(word, "volup") ? 0xE9 : !strcmp(word, "voldown") ? 0xEA : 0;
      if (!code) { fail([NSString stringWithFormat:@"unknown button %s", word]); break; }
      dispatch_async(hidQ, ^{ sendButton(0x0C, code, 1); usleep(60000); sendButton(0x0C, code, 2); });
      break;
    }
    case 'K': { unsigned usage = 0; sscanf(line + 1, "%i", (int *)&usage);
      dispatch_async(hidQ, ^{ sendKey(usage, 1); usleep(20000); sendKey(usage, 2); }); break; }
    case 'q': exit(0);
  }
}

int main(int argc, char **argv) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    if (argc < 2) { fprintf(stderr, "usage: simbridge <udid> [developer-dir]\n"); return 64; }
    outQ = dispatch_queue_create("simbridge.out", DISPATCH_QUEUE_SERIAL);
    encQ = dispatch_queue_create("simbridge.encode", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    hidQ = dispatch_queue_create("simbridge.touch", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    NSString *dev = argc > 2 ? @(argv[2]) : @"/Applications/Xcode.app/Contents/Developer";
    device = findDevice(@(argv[1]), dev);
    if (!device) { fail(@"no such simulator"); fflush(stdout); usleep(100000); return 2; }
    if (deviceState() != 3) { fail(@"the simulator is not booted"); usleep(100000); return 3; }
    tick = dispatch_source_create(DISPATCH_SOURCE_TYPE_DATA_OR, 0, 0, encQ);
    dispatch_source_set_event_handler(tick, ^{ onFrame(); });
    dispatch_resume(tick);
    if (!watchScreen()) { usleep(100000); return 4; }
    dispatch_async(hidQ, ^{ connectHid(1); });
    emitJSON('i', @{ @"ready": @YES, @"udid": @(argv[1]) });
    // The simulator going away ends the helper: its surface and service die with it.
    dispatch_source_t alive = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(0, 0));
    dispatch_source_set_timer(alive, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), 2 * NSEC_PER_SEC, NSEC_PER_SEC / 2);
    dispatch_source_set_event_handler(alive, ^{ if (deviceState() != 3) { fail(@"the simulator shut down"); usleep(100000); exit(3); } });
    dispatch_resume(alive);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
      char line[512];
      while (fgets(line, sizeof line, stdin)) command(line);
      exit(0);   // the server went away
    });
    dispatch_main();
  }
}
