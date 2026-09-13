import SwiftUI

// A host app exists only because a UI-test bundle must have one. The agent never launches
// it; it attaches to whichever app the composer asks about by bundle identifier.
@main
struct HostApp: App {
    var body: some Scene { WindowGroup { Text("emu-composer agent host") } }
}
