import XCTest
import Network
import Foundation

// The agent is a UI test that never finishes: it opens an HTTP listener and, for as long as
// `xcodebuild test-without-building` keeps it alive, answers questions about ANY app on the
// simulator by bundle identifier — the accessibility tree (what u2.jar gives the Android side),
// the app's run state, and simple input. Nothing here is specific to one app.
//
// Every XCUI call is made on the main thread: the test method parks there in a run loop, and
// requests arriving on the listener's queue hop over with `DispatchQueue.main.sync`.
final class AgentTests: XCTestCase {
    func testServe() throws {
        let port = UInt16(ProcessInfo.processInfo.environment["EMU_AGENT_PORT"] ?? "") ?? 8100
        let server = try AgentServer(port: port)
        server.start()
        NSLog("emu-agent listening on \(port)")
        while true { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25)) }
    }
}

final class AgentServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "emu-agent")
    private var apps: [String: XCUIApplication] = [:]

    init(port: UInt16) throws {
        guard let p = NWEndpoint.Port(rawValue: port) else { throw NSError(domain: "emu-agent", code: 1) }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params, on: p)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] c in self?.serve(c) }
        listener.start(queue: queue)
    }

    // One request per connection, closed after the reply — the composer's calls are few and
    // short, and keep-alive is complexity for nothing.
    private func serve(_ c: NWConnection) {
        c.start(queue: queue)
        var buf = Data()
        func receive() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, done, err in
                if let d = data { buf.append(d) }
                let text = String(decoding: buf, as: UTF8.self)
                if text.contains("\r\n\r\n") || done || err != nil {
                    let (status, body) = self.route(text)
                    let head = "HTTP/1.1 \(status)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                    c.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in c.cancel() })
                } else { receive() }
            }
        }
        receive()
    }

    private func route(_ raw: String) -> (String, Data) {
        let line = raw.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
        let parts = line.split(separator: " ")
        guard parts.count >= 2, let url = URLComponents(string: String(parts[1])) else { return ("400 Bad Request", json(["error": "bad request"])) }
        var q: [String: String] = [:]
        for it in url.queryItems ?? [] { q[it.name] = it.value ?? "" }
        var result: (String, Data) = ("404 Not Found", json(["error": "not found"]))
        // XCUI is main-thread work; the test method is parked in a run loop there.
        DispatchQueue.main.sync {
            do {
                switch url.path {
                case "/health":
                    result = ("200 OK", json(["ok": true, "pid": ProcessInfo.processInfo.processIdentifier]))
                case "/tree":
                    result = ("200 OK", try tree(bundle: q["bundle"] ?? ""))
                case "/tap":
                    let app = try self.app(q["bundle"] ?? "")
                    let x = Double(q["x"] ?? "") ?? 0, y = Double(q["y"] ?? "") ?? 0
                    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
                    result = ("200 OK", json(["ok": true]))
                case "/type":
                    let app = try self.app(q["bundle"] ?? "")
                    app.typeText(q["text"] ?? "")
                    result = ("200 OK", json(["ok": true]))
                default: break
                }
            } catch {
                result = ("500 Internal Server Error", json(["error": "\(error)"]))
            }
        }
        return result
    }

    private func app(_ bundle: String) throws -> XCUIApplication {
        guard !bundle.isEmpty else { throw NSError(domain: "emu-agent", code: 2, userInfo: [NSLocalizedDescriptionKey: "bundle is required"]) }
        if let a = apps[bundle] { return a }
        let a = XCUIApplication(bundleIdentifier: bundle)
        apps[bundle] = a
        return a
    }

    // The whole accessibility tree, flattened in document order with a depth per node, in
    // POINTS. The composer scales to pixels against its own screenshot.
    private func tree(bundle: String) throws -> Data {
        let a = try app(bundle)
        let state = a.state.rawValue
        guard a.state == .runningForeground || a.state == .runningBackground else {
            return json(["state": state, "nodes": [], "error": "app is not running (state \(state))"])
        }
        let snap = try a.snapshot()
        var nodes: [[String: Any]] = []
        flatten(snap, depth: 0, into: &nodes)
        return json(["state": state, "nodes": nodes])
    }

    private func flatten(_ s: XCUIElementSnapshot, depth: Int, into out: inout [[String: Any]]) {
        let f = s.frame
        out.append([
            "depth": depth, "type": name(s.elementType), "id": s.identifier, "label": s.label, "title": s.title,
            "value": (s.value as? String) ?? (s.value.map { "\($0)" } ?? ""),
            "placeholder": s.placeholderValue ?? "",
            "x": f.minX.isFinite ? f.minX : 0, "y": f.minY.isFinite ? f.minY : 0,
            "w": f.width.isFinite ? f.width : 0, "h": f.height.isFinite ? f.height : 0,
            "enabled": s.isEnabled, "selected": s.isSelected, "focus": s.hasFocus,
        ])
        for c in s.children { flatten(c, depth: depth + 1, into: &out) }
    }

    private func name(_ t: XCUIElement.ElementType) -> String {
        switch t {
        case .application: return "Application"; case .window: return "Window"; case .other: return "Other"
        case .button: return "Button"; case .staticText: return "StaticText"; case .textField: return "TextField"
        case .secureTextField: return "SecureTextField"; case .textView: return "TextView"; case .image: return "Image"
        case .cell: return "Cell"; case .table: return "Table"; case .collectionView: return "CollectionView"
        case .scrollView: return "ScrollView"; case .switch: return "Switch"; case .slider: return "Slider"
        case .tabBar: return "TabBar"; case .tab: return "Tab"; case .navigationBar: return "NavigationBar"
        case .toolbar: return "Toolbar"; case .segmentedControl: return "SegmentedControl"; case .picker: return "Picker"
        case .pickerWheel: return "PickerWheel"; case .link: return "Link"; case .searchField: return "SearchField"
        case .alert: return "Alert"; case .sheet: return "Sheet"; case .popover: return "Popover"
        case .menu: return "Menu"; case .menuItem: return "MenuItem"; case .menuButton: return "MenuButton"
        case .keyboard: return "Keyboard"; case .key: return "Key"; case .map: return "Map"; case .webView: return "WebView"
        case .checkBox: return "CheckBox"; case .radioButton: return "RadioButton"; case .progressIndicator: return "ProgressIndicator"
        case .activityIndicator: return "ActivityIndicator"; case .pageIndicator: return "PageIndicator"
        case .datePicker: return "DatePicker"; case .stepper: return "Stepper"; case .group: return "Group"
        case .dialog: return "Dialog"; case .toggle: return "Toggle"
        default: return "Other(\(t.rawValue))"
        }
    }

    private func json(_ o: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: o, options: [])) ?? Data("{}".utf8)
    }
}
