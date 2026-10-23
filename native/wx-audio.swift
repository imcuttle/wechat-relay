// wx-audio: CoreAudio helper for WeChat Relay voice messages. One JSON object per call on stdout.
//   wx-audio devices                 list audio devices (uid, name, input/output, running somewhere)
//   wx-audio get-input               current default input device
//   wx-audio set-input <uid>         set the default input device
//   wx-audio duration <file>         length of an audio file in seconds
//   wx-audio play <file> <uid>       play a file on one specific output device (the system default output is untouched)
import AVFoundation
import CoreAudio
import Foundation

func out(_ o: [String: Any]) -> Never {
    let d = try! JSONSerialization.data(withJSONObject: o)
    print(String(data: d, encoding: .utf8)!)
    exit(o["ok"] as? Bool == false ? 1 : 0)
}
func fail(_ m: String) -> Never { out(["ok": false, "error": m]) }

func addr(_ s: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: s, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func str(_ id: AudioObjectID, _ s: AudioObjectPropertySelector) -> String {
    var a = addr(s); var v: Unmanaged<CFString>?; var n = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &n, &v) == noErr, let r = v else { return "" }
    return r.takeRetainedValue() as String
}
func channels(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int {
    var a = addr(kAudioDevicePropertyStreamConfiguration, scope); var n: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &a, 0, nil, &n) == noErr else { return 0 }
    let p = UnsafeMutableRawPointer.allocate(byteCount: Int(n), alignment: 16); defer { p.deallocate() }
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &n, p) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(p.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}
func running(_ id: AudioObjectID) -> Bool {
    var a = addr(kAudioDevicePropertyDeviceIsRunningSomewhere); var v: UInt32 = 0; var n = UInt32(4)
    return AudioObjectGetPropertyData(id, &a, 0, nil, &n, &v) == noErr && v != 0
}
func allDevices() -> [AudioObjectID] {
    var a = addr(kAudioHardwarePropertyDevices); var n: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &n) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(n) / MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &n, &ids)
    return ids
}
func info(_ id: AudioObjectID) -> [String: Any] {
    ["id": Int(id), "uid": str(id, kAudioDevicePropertyDeviceUID), "name": str(id, kAudioObjectPropertyName),
     "input": channels(id, kAudioDevicePropertyScopeInput) > 0, "output": channels(id, kAudioDevicePropertyScopeOutput) > 0,
     "running": running(id)]
}
func defaultInput() -> AudioObjectID {
    var a = addr(kAudioHardwarePropertyDefaultInputDevice); var v = AudioObjectID(0); var n = UInt32(4)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &n, &v)
    return v
}
func find(uid: String) -> AudioObjectID? { allDevices().first { str($0, kAudioDevicePropertyDeviceUID) == uid } }

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: wx-audio devices|get-input|set-input|duration|play") }
switch args[1] {
case "devices":
    out(["ok": true, "devices": allDevices().map(info)])
case "get-input":
    let d = defaultInput(); guard d != 0 else { fail("no default input device") }
    var o = info(d); o["ok"] = true; out(o)
case "set-input":
    guard args.count >= 3, var id = find(uid: args[2]) else { fail("device not found") }
    var a = addr(kAudioHardwarePropertyDefaultInputDevice)
    let st = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, UInt32(4), &id)
    guard st == noErr else { fail("set default input failed (\(st))") }
    out(["ok": true, "uid": args[2]])
case "duration":
    guard args.count >= 3, let f = try? AVAudioFile(forReading: URL(fileURLWithPath: args[2])) else { fail("cannot read audio") }
    out(["ok": true, "seconds": Double(f.length) / f.processingFormat.sampleRate])
case "play":
    guard args.count >= 4 else { fail("usage: play <file> <uid>") }
    guard find(uid: args[3]) != nil else { fail("output device not found") }
    guard let p = try? AVAudioPlayer(contentsOf: URL(fileURLWithPath: args[2])) else { fail("cannot read audio") }
    p.currentDevice = args[3]
    guard p.prepareToPlay(), p.play() else { fail("cannot play") }
    while p.isPlaying { Thread.sleep(forTimeInterval: 0.05) }
    out(["ok": true, "seconds": p.duration])
default:
    fail("unknown command")
}
