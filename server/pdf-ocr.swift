import AppKit
import PDFKit
import Vision

let arguments = CommandLine.arguments.dropFirst()
let data = FileHandle.standardInput.readDataToEndOfFile()
guard let document = PDFDocument(data: data) else {
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let available = try request.supportedRecognitionLanguages()
request.recognitionLanguages = ["zh-Hant", "en-US"].filter { language in
    available.contains(language)
}

var results: [String: String] = [:]
for argument in arguments {
    guard let number = Int(argument), let page = document.page(at: number - 1) else {
        continue
    }
    let bounds = page.bounds(for: .mediaBox)
    let maxSide = max(bounds.width, bounds.height)
    guard maxSide > 0, maxSide.isFinite else { continue }
    let scale = min(3, 2300 / maxSide)
    let size = NSSize(width: bounds.width * scale, height: bounds.height * scale)
    let thumbnail = page.thumbnail(of: size, for: .mediaBox)
    var rectangle = NSRect(origin: .zero, size: thumbnail.size)
    guard let image = thumbnail.cgImage(forProposedRect: &rectangle, context: nil, hints: nil) else {
        continue
    }
    let handler = VNImageRequestHandler(cgImage: image)
    try handler.perform([request])
    results[argument] = request.results?.compactMap {
        $0.topCandidates(1).first?.string
    }.joined(separator: "\n") ?? ""
}
FileHandle.standardOutput.write(try JSONEncoder().encode(results))
