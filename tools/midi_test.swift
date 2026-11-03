// Sends test notes directly to the MPC through CoreMIDI, without the browser,
// and prints anything the MPC sends back.
// Usage: swift tools/midi_test.swift [listenSeconds]
import CoreMIDI
import Foundation

func name(_ ref: MIDIObjectRef) -> String {
    var value: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(ref, kMIDIPropertyDisplayName, &value)
    return (value?.takeRetainedValue() as String?) ?? "?"
}

var client = MIDIClientRef()
MIDIClientCreateWithBlock("mpc-grid-test" as CFString, &client, nil)

var input = MIDIPortRef()
MIDIInputPortCreateWithBlock(client, "in" as CFString, &input) { list, _ in
    var packet = list.pointee.packet
    for _ in 0..<list.pointee.numPackets {
        let bytes = withUnsafeBytes(of: packet.data) { Array($0.prefix(Int(packet.length))) }
        if bytes.first != 0xF8 && bytes.first != 0xFE {
            print("from MPC: " + bytes.map { String(format: "%02X", $0) }.joined(separator: " "))
        }
        packet = MIDIPacketNext(&packet).pointee
    }
}
for i in 0..<MIDIGetNumberOfSources() {
    MIDIPortConnectSource(input, MIDIGetSource(i), nil)
}

var destination: MIDIEndpointRef = 0
for i in 0..<MIDIGetNumberOfDestinations() where name(MIDIGetDestination(i)).contains("MPC") {
    destination = MIDIGetDestination(i)
}
guard destination != 0 else {
    print("MPC MIDI port not found. Exit SD Card Access mode.")
    exit(1)
}

var output = MIDIPortRef()
MIDIOutputPortCreate(client, "out" as CFString, &output)

func send(_ bytes: [UInt8]) {
    var list = MIDIPacketList()
    let packet = MIDIPacketListInit(&list)
    _ = MIDIPacketListAdd(&list, MemoryLayout<MIDIPacketList>.size, packet, 0, bytes.count, bytes)
    let status = MIDISend(output, destination, &list)
    if status != noErr { print("send failed: \(status)") }
}

print("Sending notes 36-51 on channel 1...")
for note in UInt8(36)...UInt8(51) {
    send([0x90, note, 110])
    Thread.sleep(forTimeInterval: 0.2)
    send([0x80, note, 0])
    Thread.sleep(forTimeInterval: 0.1)
}
let listen = Double(CommandLine.arguments.dropFirst().first ?? "2") ?? 2
print("Listening for \(listen) seconds...")
RunLoop.current.run(until: Date().addingTimeInterval(listen))
print("Done.")
