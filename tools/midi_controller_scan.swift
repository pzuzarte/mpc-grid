// Finds which MIDI controllers change the sound on the MPC. First checks whether pan
// and volume affect one pad or all of them, then sweeps every other controller while
// playing pad A01. Press Return whenever the sound changes to note the number.
// Sends MIDI only. Run with the MPC out of SD mode.
// Usage: swift tools/midi_controller_scan.swift
import CoreMIDI
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let padA01: UInt8 = 36
let padA02: UInt8 = 37
let velocity: UInt8 = 100
let hitSeconds = 0.5
let stepsPerHit = 20

// Controllers 120-127 are reserved commands such as "all notes off", and these were
// covered by the first test.
let alreadyTested: Set<UInt8> = [1, 7, 10, 71, 74]
let controllers = (UInt8(0)...UInt8(119)).filter { !alreadyTested.contains($0) }

func name(_ ref: MIDIObjectRef) -> String {
    var value: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(ref, kMIDIPropertyDisplayName, &value)
    return (value?.takeRetainedValue() as String?) ?? "?"
}

var client = MIDIClientRef()
MIDIClientCreateWithBlock("mpc-grid-controller-scan" as CFString, &client, nil)

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

// Starts at the middle, rises, falls, and returns to the middle.
func sweepValue(_ position: Double) -> UInt8 {
    let wave = position < 0.25 ? 0.5 + position * 2
        : position < 0.75 ? 1 - (position - 0.25) * 2
        : (position - 0.75) * 2
    return UInt8((wave * 127).rounded())
}

func play(notes: [UInt8], hits: Int, controller: UInt8) {
    for hit in 0..<hits {
        let note = notes[hit % notes.count]
        send([0x90, note, velocity])
        for step in 0..<stepsPerHit {
            let position = (Double(hit) + Double(step) / Double(stepsPerHit)) / Double(hits)
            send([0xB0, controller, sweepValue(position)])
            Thread.sleep(forTimeInterval: hitSeconds / Double(stepsPerHit))
        }
        send([0x80, note, 0])
    }
}

let lock = NSLock()
var currentLabel = ""
var marks: [String] = []
var scanning = false

func setLabel(_ label: String) {
    lock.lock()
    currentLabel = label
    lock.unlock()
}

// Return marks whichever controller is playing now, and the one before it, since
// there's a short delay between hearing a change and pressing the key.
var previousLabel = ""
func listenForMarks() {
    Thread.detachNewThread {
        while readLine() != nil {
            lock.lock()
            if scanning {
                let mark = "\(currentLabel) (or \(previousLabel))"
                marks.append(mark)
                print("    NOTED: \(mark)")
            }
            lock.unlock()
        }
    }
}

print("MIDI controller scan")
print("Part 1 checks pan and volume on two pads. Part 2 scans \(controllers.count) controllers.")
print("Press Return here to start.")
_ = readLine()

print("")
print("PART 1a: PAN with A01 and A02 taking turns")
print("If both pads move together, pan affects the whole track.")
play(notes: [padA01, padA02], hits: 16, controller: 10)
send([0xB0, 10, 64])
Thread.sleep(forTimeInterval: 0.5)

print("")
print("PART 1b: VOLUME with A01 and A02 taking turns")
print("If both pads rise and fall together, volume affects the whole track.")
play(notes: [padA01, padA02], hits: 16, controller: 7)
send([0xB0, 7, 100])
Thread.sleep(forTimeInterval: 0.5)

print("")
print("PART 2: Press Return whenever the filter, resonance, pitch or anything else changes.")
Thread.sleep(forTimeInterval: 2)
listenForMarks()
lock.lock()
scanning = true
lock.unlock()

let startedAt = Date()
for (index, controller) in controllers.enumerated() {
    lock.lock()
    previousLabel = currentLabel.isEmpty ? "none" : currentLabel
    currentLabel = "controller \(controller)"
    lock.unlock()
    print("\(index + 1) of \(controllers.count): controller \(controller)")
    play(notes: [padA01], hits: 4, controller: controller)
}

lock.lock()
scanning = false
print("")
print(String(format: "Done after %.0f seconds.", Date().timeIntervalSince(startedAt)))
if marks.isEmpty {
    print("RESULT: no controllers were noted.")
} else {
    print("RESULT: you noted:")
    marks.forEach { print("  \($0)") }
}
lock.unlock()
exit(0)
