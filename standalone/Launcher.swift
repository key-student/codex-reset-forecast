import AppKit
import CoreGraphics
import Darwin

@MainActor
final class Launcher {
    private let appURL: URL
    private let executable: String
    private let node: URL
    private let agent: String
    private let dataDirectory: String
    private let workspace = NSWorkspace.shared
    private let stateURL: URL
    private var starting = false
    private var stopping = false
    private var child: Process?
    private var managedPID: pid_t?
    private var signals: [DispatchSourceSignal] = []

    init(appURL: URL, node: URL, agent: String, dataDirectory: String, executable: String) {
        self.appURL = appURL
        self.node = node
        self.agent = agent
        self.dataDirectory = dataDirectory
        self.executable = executable
        self.stateURL = URL(fileURLWithPath: dataDirectory).appendingPathComponent("last-launch")
    }

    func start() {
        let center = workspace.notificationCenter
        center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated { self?.didLaunch(app) }
        }
        center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated {
                guard let self, self.managedPID == app.processIdentifier else { return }
                self.stopAgent()
            }
        }
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                MainActor.assumeIsolated {
                    self?.shutdown()
                }
            }
            source.resume()
            signals.append(source)
        }
    }

    private var apps: [NSRunningApplication] {
        workspace.runningApplications.filter { matches($0) && !$0.isTerminated }
    }

    private func matches(_ app: NSRunningApplication) -> Bool {
        app.bundleIdentifier == "com.openai.codex" &&
            app.bundleURL?.resolvingSymlinksInPath().path == appURL.path
    }

    private func didLaunch(_ app: NSRunningApplication) {
        guard matches(app), !starting, !stopping, child == nil else { return }
        starting = true
        Task {
            defer {
                starting = false
                if stopping { CFRunLoopStop(CFRunLoopGetMain()) }
            }
            await handoff(app)
        }
    }

    private func idleTime() -> TimeInterval {
        let events: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        return events.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    }

    private func unmodifiedLaunch(_ app: NSRunningApplication) -> Bool {
        let command = Process()
        command.executableURL = URL(fileURLWithPath: "/bin/ps")
        command.arguments = ["-ww", "-p", String(app.processIdentifier), "-o", "command="]
        let output = Pipe()
        command.standardOutput = output
        command.standardError = FileHandle.nullDevice
        do { try command.run() } catch { return false }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        command.waitUntilExit()
        let launched = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard command.terminationStatus == 0, launched.hasPrefix("/") else { return false }
        return URL(fileURLWithPath: launched).resolvingSymlinksInPath().path ==
            URL(fileURLWithPath: executable).resolvingSymlinksInPath().path
    }

    private func eligible(_ app: NSRunningApplication, since launch: Date) -> Bool {
        let age = Date().timeIntervalSince(launch)
        return age >= 0 && age <= 8 && idleTime() >= age &&
            apps.count == 1 && apps.first?.processIdentifier == app.processIdentifier
    }

    private func reserveAttempt() -> Bool {
        let now = Date().timeIntervalSince1970
        if FileManager.default.fileExists(atPath: stateURL.path) {
            guard let saved = try? String(contentsOf: stateURL, encoding: .utf8),
                  let previous = Double(saved), previous.isFinite, now - previous >= 120 else { return false }
        }
        do {
            try String(now).write(to: stateURL, atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    private func freePort() -> UInt16? {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return nil }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let read = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(descriptor, $0, &length)
            }
        }
        let port = UInt16(bigEndian: address.sin_port)
        return read == 0 && port >= 49152 ? port : nil
    }

    private func handoff(_ app: NSRunningApplication) async {
        guard let launch = app.launchDate else { return }
        while !stopping && eligible(app, since: launch) && (!app.isFinishedLaunching || !app.isActive) {
            try? await Task.sleep(for: .milliseconds(150))
        }
        guard !stopping, eligible(app, since: launch), app.isFinishedLaunching, app.isActive,
              unmodifiedLaunch(app), let port = freePort(), reserveAttempt(),
              eligible(app, since: launch), app.isActive else { return }

        let quitAt = Date()
        guard app.terminate() else { return }
        let deadline = quitAt.addingTimeInterval(10)
        while !app.isTerminated && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(150))
        }
        guard app.isTerminated, apps.isEmpty else { return }

        if stopping {
            _ = await openCodex([])
            return
        }

        let frontmostPID = workspace.frontmostApplication?.processIdentifier
        let arguments = ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=\(port)"]
        if let pid = await openCodex(arguments), let opened = NSRunningApplication(processIdentifier: pid),
           matches(opened) {
            guard !stopping else { return }
            startAgent(pid: pid, port: port)
            if idleTime() >= Date().timeIntervalSince(quitAt),
               workspace.frontmostApplication?.processIdentifier == frontmostPID {
                _ = opened.activate()
            }
        } else if apps.isEmpty {
            NSLog("Codex Reset Forecast: reopening Codex without the forecast.")
            _ = await openCodex([])
        }
    }

    private func openCodex(_ arguments: [String]) async -> pid_t? {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.activates = arguments.isEmpty
        configuration.arguments = arguments
        return await withCheckedContinuation { continuation in
            workspace.openApplication(at: appURL, configuration: configuration) { app, _ in
                continuation.resume(returning: app?.processIdentifier)
            }
        }
    }

    private func startAgent(pid: pid_t, port: UInt16) {
        let process = Process()
        process.executableURL = node
        process.arguments = [agent, String(pid), String(port), dataDirectory]
        process.terminationHandler = { [weak self] process in
            Task { @MainActor [weak self] in
                guard let self, self.child === process else { return }
                self.child = nil
                self.managedPID = nil
            }
        }
        do {
            try process.run()
            child = process
            managedPID = pid
        } catch {
            NSLog("Codex Reset Forecast: could not start Node.js.")
        }
    }

    private func shutdown() {
        stopping = true
        stopAgent()
        if !starting { CFRunLoopStop(CFRunLoopGetMain()) }
    }

    private func stopAgent() {
        if let child, child.isRunning {
            child.terminate()
        }
        child = nil
        managedPID = nil
    }
}

@main
struct Main {
    @MainActor
    static func main() {
        let arguments = CommandLine.arguments
        guard arguments.count == 5 else { exit(64) }
        let app = URL(fileURLWithPath: arguments[1]).resolvingSymlinksInPath()
        guard let bundle = Bundle(url: app), bundle.bundleIdentifier == "com.openai.codex",
              let executable = bundle.executableURL?.path else { exit(64) }
        let launcher = Launcher(
            appURL: app, node: URL(fileURLWithPath: arguments[2]), agent: arguments[3],
            dataDirectory: arguments[4], executable: executable
        )
        launcher.start()
        withExtendedLifetime(launcher) { CFRunLoopRun() }
    }
}
