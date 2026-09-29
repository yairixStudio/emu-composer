// Emu Composer Bar — a small floating bar that docks to the Android Emulator window and
// holds one button: open the composer. Lives in the menu bar too, so it can be hidden and
// brought back. No windows of its own beyond the bar.
//
//   EmuComposerBar --launch "<shell command>" --port 7788 --title "App Composer" --owner qemu-system
//
// The emulator window is found through the window list by its owner's name (the standalone
// emulator is a qemu-system-* process); the bar follows it and hides when it is gone.
import AppKit
import Foundation

let argv = CommandLine.arguments
func arg(_ name: String, _ def: String) -> String {
    if let i = argv.firstIndex(of: "--\(name)"), i + 1 < argv.count { return argv[i + 1] }
    return def
}
let launchCmd = arg("launch", "")
let port = Int(arg("port", "7788")) ?? 7788
let title = arg("title", "Composer")
let ownerMatch = arg("owner", "qemu-system").lowercased()

final class Bar: NSObject, NSApplicationDelegate {
    var panel: NSPanel!
    var status: NSStatusItem!
    var dot: NSView!
    var button: NSButton!
    var hidden = false
    var lastFrame = CGRect.zero
    let barW: CGFloat = 176, barH: CGFloat = 34

    func applicationDidFinishLaunching(_ n: Notification) {
        buildPanel(); buildMenu()
        Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in self.follow() }
        // Re-stack at once when any app comes forward, instead of waiting for the next tick.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                          object: nil, queue: .main) { _ in self.follow() }
        Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { _ in self.health() }
        follow(); health()
    }

    func buildPanel() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: barW, height: barH),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // Normal level, stacked directly above the emulator window in follow(): the bar lives in
        // the emulator's layer, so a browser brought in front of the emulator covers the bar too
        // (2026-09-29: at .floating it stayed on top of every app and hid what the owner was
        // reading).
        panel.level = .normal
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false

        let fx = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: barW, height: barH))
        fx.material = .hudWindow; fx.state = .active; fx.blendingMode = .behindWindow
        fx.wantsLayer = true; fx.layer?.cornerRadius = 9; fx.layer?.masksToBounds = true
        fx.layer?.borderWidth = 0.5; fx.layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
        panel.contentView = fx

        let icon = NSImageView(frame: NSRect(x: 9, y: 8, width: 18, height: 18))
        icon.image = NSImage(systemSymbolName: "wand.and.stars", accessibilityDescription: nil)
        icon.contentTintColor = NSColor(red: 0.98, green: 0.45, blue: 0.09, alpha: 1)
        fx.addSubview(icon)

        button = NSButton(title: title, target: self, action: #selector(open))
        button.frame = NSRect(x: 30, y: 5, width: 104, height: 24)
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.font = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
        button.keyEquivalent = "\r"
        fx.addSubview(button)

        dot = NSView(frame: NSRect(x: 142, y: 13, width: 8, height: 8))
        dot.wantsLayer = true; dot.layer?.cornerRadius = 4; dot.layer?.backgroundColor = NSColor.gray.cgColor
        dot.toolTip = "server: unknown"
        fx.addSubview(dot)

        let close = NSButton(title: "×", target: self, action: #selector(hide))
        close.frame = NSRect(x: 154, y: 6, width: 18, height: 22)
        close.isBordered = false
        close.font = NSFont.systemFont(ofSize: 14, weight: .regular)
        close.contentTintColor = .secondaryLabelColor
        close.toolTip = "Hide the bar (menu bar ◧ brings it back)"
        fx.addSubview(close)
    }

    func buildMenu() {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.button?.image = NSImage(systemSymbolName: "rectangle.lefthalf.inset.filled", accessibilityDescription: title)
        let m = NSMenu()
        m.addItem(withTitle: "Open \(title)", action: #selector(open), keyEquivalent: "o").target = self
        m.addItem(withTitle: "Show bar", action: #selector(show), keyEquivalent: "").target = self
        m.addItem(withTitle: "Hide bar", action: #selector(hide), keyEquivalent: "").target = self
        m.addItem(.separator())
        m.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = m
    }

    // The emulator's footprint: the UNION of its normal-layer windows. The standalone emulator
    // is two windows — the phone and a 54 px side toolbar to its right — and docking to the
    // largest one alone put the bar on top of that toolbar (measured: phone 353×813 at x=100,
    // toolbar 54×506 at x=453).
    // Also returns the emulator's FRONTMOST window number (the list is front-to-back) and
    // whether the bar already sits directly above it, so follow() re-stacks only when needed.
    func emulatorFrame() -> (frame: CGRect, top: Int, stacked: Bool)? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        var union: CGRect? = nil
        var top = 0, topIdx = -1, barIdx = -1
        for (i, w) in list.enumerated() {
            if (w[kCGWindowNumber as String] as? Int) == panel.windowNumber { barIdx = i; continue }
            guard let owner = (w[kCGWindowOwnerName as String] as? String)?.lowercased(), owner.contains(ownerMatch),
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
            let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            if r.width < 30 || r.height < 200 { continue }           // menu bar rows, tooltips
            union = union.map { $0.union(r) } ?? r
            if topIdx < 0 { topIdx = i; top = (w[kCGWindowNumber as String] as? Int) ?? 0 }
        }
        guard let u = union else { return nil }
        return (u, top, barIdx >= 0 && barIdx == topIdx - 1)
    }

    // CG coordinates have their origin at the top-left of the primary display; AppKit at the
    // bottom-left. Dock to the top-right of the window, or top-left if that runs off-screen.
    func follow() {
        guard let e = emulatorFrame() else { if panel.isVisible { panel.orderOut(nil) }; return }
        if hidden { return }
        let f = e.frame
        let primaryH = NSScreen.screens.first?.frame.height ?? 0
        var x = f.maxX + 8
        let y = primaryH - f.minY - barH
        let screenMaxX = (NSScreen.screens.map { $0.frame.maxX }.max() ?? 0)
        if x + barW > screenMaxX { x = f.minX - barW - 8 }
        let target = NSPoint(x: x, y: y)
        if f != lastFrame || !panel.isVisible {
            lastFrame = f
            panel.setFrameOrigin(target)
        }
        // Keep the bar exactly one step above the emulator in the window stack — never above
        // whatever app the user brought in front of it.
        if !e.stacked || !panel.isVisible { panel.order(.above, relativeTo: e.top) }
    }

    func health() {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return }
        var req = URLRequest(url: url); req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var color = NSColor.gray, tip = "server: not running (click to start)"
            if let d = data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                let agent = (j["agent"] as? Bool) ?? false
                color = agent ? NSColor(red: 0.2, green: 0.83, blue: 0.6, alpha: 1) : NSColor(red: 0.98, green: 0.75, blue: 0.14, alpha: 1)
                tip = agent ? "server up · agent on the fast path" : "server up · agent off (slow path)"
            }
            DispatchQueue.main.async { self.dot.layer?.backgroundColor = color.cgColor; self.dot.toolTip = tip }
        }.resume()
    }

    @objc func open() {
        guard !launchCmd.isEmpty else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", launchCmd]
        let log = FileHandle(forWritingAtPath: NSHomeDirectory() + "/Library/Logs/emu-composer.log")
        log?.seekToEndOfFile(); p.standardOutput = log; p.standardError = log
        try? p.run()
        button.title = "Opening…"
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.button.title = title; self.health() }
    }
    @objc func hide() { hidden = true; panel.orderOut(nil) }
    @objc func show() { hidden = false; follow() }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let bar = Bar()
app.delegate = bar
app.run()
