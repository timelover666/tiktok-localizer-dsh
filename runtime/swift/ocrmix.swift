import Foundation
import Vision
import ImageIO
import CoreGraphics

func jsonEscape(_ s: String) -> String {
    var out = ""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 { out += String(format: "\\u%04x", ch.value) }
            else { out.unicodeScalars.append(ch) }
        }
    }
    return out
}
let args = Array(CommandLine.arguments.dropFirst())
let langs = ProcessInfo.processInfo.environment["OCR_LANGS"]?.split(separator: ",").map(String.init) ?? ["ja-JP","ko-KR","en-US"]
for path in args {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        print("{\"f\":\"\(jsonEscape(path))\",\"error\":\"load\"}")
        continue
    }
    let w = CGFloat(cg.width), h = CGFloat(cg.height)
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    req.recognitionLanguages = langs
    if #available(macOS 13.0, *) { req.revision = VNRecognizeTextRequestRevision3; req.automaticallyDetectsLanguage = true }
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch {
        print("{\"f\":\"\(jsonEscape(path))\",\"error\":\"ocr\"}")
        continue
    }
    var parts: [String] = []
    for o in (req.results ?? []) {
        guard let t = o.topCandidates(1).first else { continue }
        let b = o.boundingBox
        parts.append("{\"t\":\"\(jsonEscape(t.string))\",\"c\":\(t.confidence),\"x\":\(b.origin.x),\"y\":\(b.origin.y),\"w\":\(b.size.width),\"h\":\(b.size.height)}")
    }
    print("{\"f\":\"\(jsonEscape(path))\",\"w\":\(w),\"h\":\(h),\"lines\":[\(parts.joined(separator: ","))]}")
}
