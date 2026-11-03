import CoreMIDI
import Foundation

func name(_ ref: MIDIObjectRef) -> String {
    var value: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(ref, kMIDIPropertyDisplayName, &value)
    return (value?.takeRetainedValue() as String?) ?? "?"
}
print("destinations (laptop -> device):")
for i in 0..<MIDIGetNumberOfDestinations() { print("  " + name(MIDIGetDestination(i))) }
print("sources (device -> laptop):")
for i in 0..<MIDIGetNumberOfSources() { print("  " + name(MIDIGetSource(i))) }
