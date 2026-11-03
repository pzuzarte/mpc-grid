// Plays pad A01 while sweeping one MIDI message at a time, to find out which ones
// change the sound on the MPC. Sends MIDI only. Run with the MPC out of SD mode.
// Usage: swift tools/midi_response_test.swift
import CoreMIDI
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let note: UInt8 = 36
let velocity: UInt8 = 100
let hitSeconds = 0.5
let hitsPerTest = 16

func name(_ ref: MIDIObjectRef) -> String {
    var value: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(ref, kMIDIPropertyDisplayName, &value)
    return (value?.takeRetainedValue() as String?) ?? "?"
}

var client = MIDIClientRef()
MIDIClientCreateWithBlock("mpc-grid-response-test" as CFString, &client, nil)

// Anything the MPC sends back, other than clock and keep-alive messages.
var input = MIDIPortRef()
MIDIInputPortCreateWithBlock(client, "in" as CFString, &input) { list, _ in
    var packet = list.pointee.packet
    for _ in 0..<list.pointee.numPackets {
        let bytes = withUnsafeBytes(of: packet.data) { Array($0.prefix(Int(packet.length))) }
        if let first = bytes.first, first < 0xF8 {
            print("    from MPC: " + bytes.map { String(format: "%02X", $0) }.joined(separator: " "))
        }
        packet = MIDIPacketNext(&packet).pointee
    }
}
for i in 0..<MIDIGetNumberOfSources() where name(MIDIGetSource(i)).contains("MPC") {
    MIDIPortConnectSource(input, MIDIGetSource(i), nil)
}

var destination: MIDIEndpointRef = 0
for i in 0..<MIDIGetNumberOfDestinations() where name(MIDIGetDestination(i)).contains("MPC") {
    destination = MIDIGetDestination(i)
}
guard destination != 0 else {
    print("MPC MIDI port not found. Exit SD Card Access mode, then run this again.")
    exit(1)
}

var output = MIDIPortRef()
MIDIOutputPortCreate(client, "out" as CFString, &output)

func send(_ bytes: [UInt8]) {
    var list = MIDIPacketList()
    let packet = MIDIPacketListInit(&list)
    _ = MIDIPacketListAdd(&list, MemoryLayout<MIDIPacketList>.size, packet, 0, bytes.count, bytes)
    MIDISend(output, destination, &list)
}

struct Test {
    let title: String
    let message: (UInt8) -> [UInt8]  // Takes a value from 0 to 127.
    let reset: [UInt8]
}

func controller(_ number: UInt8, normal: UInt8, title: String) -> Test {
    Test(title: "\(title) (controller \(number))",
         message: { [0xB0, number, $0] },
         reset: [0xB0, number, normal])
}

let tests = [
    Test(title: "No changes: this is the normal sound", message: { _ in [] }, reset: []),
    controller(74, normal: 127, title: "Filter cutoff"),
    controller(71, normal: 0, title: "Resonance"),
    controller(10, normal: 64, title: "Pan"),
    controller(7, normal: 127, title: "Volume"),
    controller(1, normal: 0, title: "Mod wheel"),
    Test(title: "Tuning (pitch bend)",
         message: { [0xE0, 0, $0] },
         reset: [0xE0, 0, 64]),
    Test(title: "Pad pressure (poly aftertouch)",
         message: { [0xA0, note, $0] },
         reset: [0xA0, note, 0]),
    Test(title: "Pad pressure (channel aftertouch)",
         message: { [0xD0, $0] },
         reset: [0xD0, 0]),
]

print("MIDI response test")
print("Listen for the sound changing DURING a test, other than the steady hits.")
print("Press Return here to start.")
_ = readLine()

let startedAt = Date()
for (index, test) in tests.enumerated() {
    print("")
    print("TEST \(index + 1) of \(tests.count): \(test.title)")
    let steps = 20
    for hit in 0..<hitsPerTest {
        send([0x90, note, velocity])
        for step in 0..<steps {
            // Up then down across the whole test, sent smoothly between hits.
            let position = (Double(hit) + Double(step) / Double(steps)) / Double(hitsPerTest)
            let triangle = position < 0.5 ? position * 2 : (1 - position) * 2
            let bytes = test.message(UInt8((triangle * 127).rounded()))
            if !bytes.isEmpty { send(bytes) }
            Thread.sleep(forTimeInterval: hitSeconds / Double(steps))
        }
        send([0x80, note, 0])
        RunLoop.current.run(until: Date())
    }
    if !test.reset.isEmpty { send(test.reset) }
    Thread.sleep(forTimeInterval: 0.5)
}
print("")
print(String(format: "Done after %.0f seconds. Everything was set back to its usual value.",
             Date().timeIntervalSince(startedAt)))
