import Foundation
import Speech

// usage: asr <audiofile> <locale>
let args = CommandLine.arguments
guard args.count >= 2 else { exit(2) }
let url = URL(fileURLWithPath: args[1])
let locale = args.count > 2 ? args[2] : "ko-KR"

let sem = DispatchSemaphore(value: 0)
SFSpeechRecognizer.requestAuthorization { status in
    FileHandle.standardError.write("auth=\(status.rawValue)\n".data(using: .utf8)!)
    sem.signal()
}
sem.wait()

guard let rec = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
    FileHandle.standardError.write("no recognizer\n".data(using: .utf8)!); exit(1)
}
FileHandle.standardError.write("available=\(rec.isAvailable) ondevice=\(rec.supportsOnDeviceRecognition)\n".data(using: .utf8)!)

let req = SFSpeechURLRecognitionRequest(url: url)
req.shouldReportPartialResults = false
if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }

var done = false
let sem2 = DispatchSemaphore(value: 0)
rec.recognitionTask(with: req) { result, error in
    if let e = error {
        FileHandle.standardError.write("error=\(e)\n".data(using: .utf8)!)
        sem2.signal(); return
    }
    if let r = result, r.isFinal {
        for seg in r.bestTranscription.segments {
            let t0 = seg.timestamp
            let t1 = t0 + seg.duration
            print("\(String(format: "%.2f", t0))\t\(String(format: "%.2f", t1))\t\(seg.substring)")
        }
        sem2.signal()
    }
}
_ = sem2.wait(timeout: .now() + 300)
