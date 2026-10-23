// wx-vision: parses a screenshot of the macOS WeChat (4.x) main window into structured data.
//
// WeChat 4.x is a Qt app whose chat content is not exposed through Accessibility, so everything here is derived
// from pixels: Apple Vision OCR for text, background-colour analysis for layout, avatar strips for message
// boundaries and bubble colour for self/other.
//
// Usage:
//   wx-vision <image.png> [scale]          one-shot, prints JSON
//   wx-vision --serve                      JSON lines on stdin: {"id":1,"image":"/p.png","scale":2}
import AppKit
import Foundation
import Vision

// MARK: - Pixels

struct RGB { var r: Int; var g: Int; var b: Int
    func dist(_ o: RGB) -> Int { max(abs(r - o.r), abs(g - o.g), abs(b - o.b)) }
    var key: Int { (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3) }
    var isGreen: Bool { g > r + 25 && g > b + 15 && g > 90 }
    var isRed: Bool { r > 190 && g < 110 && b < 110 && r - g > 100 }
    var lum: Int { (r * 3 + g * 6 + b) / 10 }
}

final class Bitmap {
    let w: Int, h: Int
    private var data: [UInt8]
    init?(path: String) {
        guard let img = NSImage(contentsOfFile: path) else { return nil }
        var rect = CGRect(origin: .zero, size: img.size)
        guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
        self.cg = cg
        w = cg.width; h = cg.height
        data = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    let cg: CGImage!
    @inline(__always) func px(_ x: Int, _ y: Int) -> RGB {
        let xx = min(max(x, 0), w - 1), yy = min(max(y, 0), h - 1)
        let i = (yy * w + xx) * 4
        return RGB(r: Int(data[i]), g: Int(data[i + 1]), b: Int(data[i + 2]))
    }
    /// Most frequent (quantised) colour along a set of points, with its share.
    func mode(_ pts: [(Int, Int)]) -> (RGB, Double) {
        var counts: [Int: (Int, RGB)] = [:]
        for (x, y) in pts { let c = px(x, y); let k = c.key; counts[k] = ((counts[k]?.0 ?? 0) + 1, c) }
        guard let best = counts.max(by: { $0.value.0 < $1.value.0 }) else { return (RGB(r: 0, g: 0, b: 0), 0) }
        return (best.value.1, Double(best.value.0) / Double(max(pts.count, 1)))
    }
}

// MARK: - OCR

struct Line: Codable { var text: String; var x: Double; var y: Double; var w: Double; var h: Double; var conf: Double
    var maxX: Double { x + w }; var maxY: Double { y + h }; var midX: Double { x + w / 2 }; var midY: Double { y + h / 2 }
}

func ocr(_ bmp: Bitmap) throws -> [Line] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    req.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: bmp.cg, options: [:]).perform([req])
    let W = Double(bmp.w), H = Double(bmp.h)
    return (req.results ?? []).compactMap { o in
        guard let c = o.topCandidates(1).first else { return nil }
        let b = o.boundingBox
        return Line(text: c.string, x: b.minX * W, y: (1 - b.maxY) * H, w: b.width * W, h: b.height * H, conf: Double(c.confidence))
    }
}

/// OCR of a region, upscaled so short / small text is recognised; lines joined top to bottom.
func ocrRegion(_ cg: CGImage, _ rect: CGRect, upscale: Double = 3) -> String {
    let area = rect.integral.intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    guard !area.isEmpty, let part = cg.cropping(to: area) else { return "" }
    let k = max(1, min(upscale, 2400 / Double(max(part.width, part.height))))
    let w = Int(Double(part.width) * k), h = Int(Double(part.height) * k)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return "" }
    ctx.interpolationQuality = .high
    ctx.draw(part, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let big = ctx.makeImage() else { return "" }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    req.usesLanguageCorrection = true
    try? VNImageRequestHandler(cgImage: big, options: [:]).perform([req])
    return (req.results ?? []).sorted { $0.boundingBox.maxY > $1.boundingBox.maxY }
        .compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
}

/// Luminance standard deviation (0-255): near 0 = flat / black / blank image.
func lumaStd(_ cg: CGImage) -> Double {
    let w = 64, h = 64
    var data = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return 0 }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    var sum = 0.0, sq = 0.0
    for i in stride(from: 0, to: data.count, by: 4) {
        let l = (Double(data[i]) * 3 + Double(data[i + 1]) * 6 + Double(data[i + 2])) / 10
        sum += l; sq += l * l
    }
    let n = Double(w * h), m = sum / n
    return (max(0, sq / n - m * m)).squareRoot()
}

struct OcrReq: Decodable { var image: String }
struct OcrResult: Encodable { var ok: Bool; var text: String; var width: Int; var height: Int; var std: Double }

func ocrFile(_ r: OcrReq) -> OcrResult {
    guard let img = NSImage(contentsOfFile: r.image) else { return OcrResult(ok: false, text: "", width: 0, height: 0, std: 0) }
    var rect = CGRect(origin: .zero, size: img.size)
    guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return OcrResult(ok: false, text: "", width: 0, height: 0, std: 0) }
    return OcrResult(ok: true, text: ocrRegion(cg, CGRect(x: 0, y: 0, width: cg.width, height: cg.height), upscale: 3),
                     width: cg.width, height: cg.height, std: lumaStd(cg))
}

// MARK: - Output model

struct Point: Codable { var x: Double; var y: Double }
struct Layout: Codable {
    var sidebarRight: Int; var listLeft: Int; var listRight: Int; var chatLeft: Int; var chatRight: Int
    var headerBottom: Int; var inputTop: Int; var input: Point; var send: Point?
    var dark: Bool; var chatBg: [Int]
}
struct Session: Codable {
    var name: String; var preview: String; var time: String; var x: Double; var y: Double; var top: Double; var bottom: Double
    var unread: Bool; var selected: Bool; var mentioned: Bool
}
struct Box: Codable { var x: Double; var y: Double; var w: Double; var h: Double }
struct Message: Codable {
    var side: String          // self | other | system
    var sender: String?
    var text: String
    var kind: String          // text | image | media | time | system
    var top: Double; var bottom: Double
    var partial: Bool
    var box: Box? = nil       // bubble / image bounds in screenshot pixels
}
struct Result: Codable {
    var ok: Bool; var error: String?
    var width: Int; var height: Int; var scale: Double
    var layout: Layout?; var title: String?; var isGroup: Bool
    var sessions: [Session]; var messages: [Message]; var lines: [Line]
    var ms: Int
}

// MARK: - Analysis

let timeRe = try! NSRegularExpression(pattern: #"^(\d{1,2}:\d{2}|\d{1,2}/\d{1,2}|\d{2,4}/\d{1,2}/\d{1,2}|昨天|前天|星期.|周.|Yesterday|\d{1,2}月\d{1,2}日)"#)
func isTimeLike(_ s: String) -> Bool {
    let t = s.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: ".。"))
    return timeRe.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil && t.count <= 16
}

/// WeChat UI overlays that are not messages: "3条新消息" pill, "以下为新消息" divider, jump-to-bottom hints.
func isNoise(_ s: String) -> Bool {
    let t = s.filter { !$0.isWhitespace && !"↓⬇⬆↑>〉›".contains($0) }
    return t.range(of: #"^(有)?\d+条(新|未读)?消息$"#, options: .regularExpression) != nil
        || ["以下为新消息", "以下是新消息", "回到最新", "回到底部", "查看最新消息"].contains(t)
        || t.range(of: #"^\d+条@?我?的?消息$"#, options: .regularExpression) != nil
}

func analyze(path: String, scaleHint: Double?) -> Result {
    let t0 = Date()
    guard let bmp = Bitmap(path: path) else {
        return Result(ok: false, error: "cannot read image", width: 0, height: 0, scale: 0, layout: nil, title: nil, isGroup: false, sessions: [], messages: [], lines: [], ms: 0)
    }
    let W = bmp.w, H = bmp.h
    let s = scaleHint ?? 2.0              // screenshot pixels per point
    func pt(_ v: Double) -> Int { Int(v * s) }

    // --- Column background profile → sidebar / list / chat split.
    let ys = stride(from: Int(Double(H) * 0.12), to: Int(Double(H) * 0.97), by: max(2, H / 300)).map { $0 }
    var colBg: [RGB?] = []
    for x in 0..<W {
        let (c, share) = bmp.mode(ys.map { (x, $0) })
        colBg.append(share > 0.55 ? c : nil)
    }
    // Stable runs of the same background colour.
    struct Run { var a: Int; var b: Int; var c: RGB }
    var runs: [Run] = []
    for x in 0..<W {
        guard let c = colBg[x] else { continue }
        if var last = runs.last, last.c.dist(c) <= 6, x - last.b <= pt(40) { last.b = x; runs[runs.count - 1] = last }
        else { runs.append(Run(a: x, b: x, c: c)) }
    }
    runs = runs.filter { $0.b - $0.a >= pt(12) }
    // Merge runs with similar colour separated only by unstable columns (avatars).
    var merged: [Run] = []
    for r in runs { if var l = merged.last, l.c.dist(r.c) <= 6 { l.b = r.b; merged[merged.count - 1] = l } else { merged.append(r) } }

    var sidebarRight = pt(60), listRight = Int(Double(W) * 0.35)
    if merged.count >= 3 {
        // Expected: [sidebar][list][chat]; chat is the run touching the right edge.
        let chatRun = merged.last!
        if let listIdx = merged.lastIndex(where: { $0.b < chatRun.a }) {
            listRight = chatRun.a
            let listRun = merged[listIdx]
            sidebarRight = listIdx > 0 ? merged[listIdx - 1].b + 1 : listRun.a
            // The list run starts where its colour begins.
            sidebarRight = max(sidebarRight, merged[0].b + 1)
        }
    } else if merged.count == 2 {
        listRight = merged[1].a; sidebarRight = pt(60)
    }
    let listLeft = sidebarRight, chatLeft = listRight, chatRight = W - 1
    let chatBg = merged.last?.c ?? bmp.px(chatLeft + pt(10), H / 2)
    let dark = chatBg.lum < 100

    let lines = (try? ocr(bmp)) ?? []
    let chatLines = lines.filter { $0.x >= Double(chatLeft) - 2 }
    let listLines = lines.filter { $0.x >= Double(listLeft) - 2 && $0.maxX <= Double(listRight) + 4 }

    // --- Chat header / title.
    let headerLimit = Double(pt(56))
    let titleLine = chatLines.filter { $0.y < headerLimit && $0.x < Double(chatLeft) + Double(chatRight - chatLeft) * 0.6 }.min(by: { $0.x < $1.x })
    var headerBottom = titleLine.map { Int($0.maxY) + pt(14) } ?? pt(48)
    // Prefer the real separator line under the header.
    do {
        let xs = [chatLeft + pt(30), chatLeft + (chatRight - chatLeft) / 2, chatRight - pt(60)]
        for y in headerBottom - pt(10)..<min(H, headerBottom + pt(16)) {
            let diff = xs.filter { bmp.px($0, y).dist(chatBg) > 6 }.count
            if diff == xs.count { headerBottom = y + 1; break }
        }
    }

    // --- Input box: anchored on the 发送/Send button.
    let sendLine = chatLines.filter { ["发送", "Send", "發送"].contains($0.text.trimmingCharacters(in: .whitespaces)) && $0.y > Double(H) * 0.5 }.max(by: { $0.y < $1.y })
    var inputTop = Int(Double(H) * 0.75)
    if let sl = sendLine {
        // The top of the input box is a border / separator spanning almost the whole chat width. Look for the first
        // such row above the send button; typed text never covers a row that densely, so it can't be mistaken for it.
        let x0 = chatLeft + pt(30), x1 = chatRight - pt(30)
        let xs = Array(stride(from: x0, to: x1, by: 3))
        let y0 = Int(sl.y) - pt(70)
        let (bg, _) = bmp.mode(xs.map { ($0, y0) })
        var found: Int? = nil
        var y = y0
        while y > Int(Double(H) * 0.4) {
            let diff = xs.filter { bmp.px($0, y).dist(bg) > 6 }.count
            if Double(diff) >= Double(xs.count) * 0.9 { found = y; break }
            y -= 1
        }
        if let f = found {
            inputTop = f
        } else {
            let probeXs = [Int(sl.x) - pt(120), chatLeft + pt(40), chatLeft + (chatRight - chatLeft) / 2]
            var tops: [Int] = []
            for px in probeXs where px > chatLeft {
                let ref = bmp.px(px, y0)
                var y = y0
                while y > Int(Double(H) * 0.4) {
                    if bmp.px(px, y).dist(ref) > 6 && bmp.px(px, y - 1).dist(ref) > 6 { break }
                    y -= 1
                }
                tops.append(y)
            }
            tops.sort()
            if !tops.isEmpty { inputTop = tops[0] }
        }
        if inputTop <= Int(Double(H) * 0.4) + 1 { inputTop = Int(sl.y) - pt(110) }
    }
    let inputPoint = Point(x: Double(chatLeft + (chatRight - chatLeft) / 2), y: Double(inputTop + pt(40)))
    let sendPoint = sendLine.map { Point(x: $0.midX, y: $0.midY) }

    // --- Avatars in the message area (they start every message).
    let areaTop = headerBottom + 2, areaBottom = inputTop - 2
    struct Avatar { var side: String; var top: Int; var bottom: Int }
    func avatars(_ xs: [Int], side: String) -> [Avatar] {
        var out: [Avatar] = []
        var start: Int? = nil
        let minLen = pt(26)
        for y in areaTop..<max(areaTop, areaBottom) {
            let hit = xs.contains { bmp.px($0, y).dist(chatBg) > 10 }
            if hit { if start == nil { start = y } }
            else if let st = start { if y - st >= minLen && y - st <= pt(48) { out.append(Avatar(side: side, top: st, bottom: y)) }; start = nil }
        }
        if let st = start, areaBottom - st >= minLen { out.append(Avatar(side: side, top: st, bottom: areaBottom)) }
        return out
    }
    // Avatar is 36pt with ~20pt margin from the chat edge.
    let otherXs = [chatLeft + pt(28), chatLeft + pt(38), chatLeft + pt(48)]
    let selfXs = [chatRight - pt(30), chatRight - pt(40), chatRight - pt(50)]
    var avs = avatars(otherXs, side: "other") + avatars(selfXs, side: "self")
    avs.sort { $0.top < $1.top }

    // --- Message lines.
    let msgLines = chatLines.filter { $0.midY > Double(areaTop) && $0.midY < Double(areaBottom) && $0.x > Double(chatLeft + pt(8)) }
    let chatMid = Double(chatLeft + chatRight) / 2, chatW = Double(chatRight - chatLeft)
    func bubbleColor(_ l: Line) -> RGB? {
        // Ring just outside the glyph box: inside a bubble it has the bubble colour, otherwise the chat background.
        let pad = Double(pt(4))
        var pts: [(Int, Int)] = []
        for i in 0..<12 {
            let fx = l.x + l.w * Double(i) / 11
            pts.append((Int(fx), Int(l.y - pad))); pts.append((Int(fx), Int(l.maxY + pad)))
        }
        pts.append((Int(l.x - pad), Int(l.midY))); pts.append((Int(l.maxX + pad), Int(l.midY)))
        let (c, share) = bmp.mode(pts)
        if share < 0.4 || c.dist(chatBg) <= 8 { return nil }
        return c
    }

    var messages: [Message] = []
    var used = Set<Int>()
    var title = titleLine?.text
    var isGroup = false
    if let t = title, let r = t.range(of: #"[（(]\d+[)）]\s*$"#, options: .regularExpression) {
        isGroup = true; title = String(t[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
    }

    /// Bounds of the bubble / image next to an avatar: rows with non-background pixels between the avatar columns,
    /// from `y0` until a background gap. Also returns each row's horizontal extent and whether it ran into `y1`.
    func contentBox(from y0: Int, to y1: Int) -> (x: Int, y: Int, w: Int, h: Int, rows: [Int: (Int, Int)], cut: Bool)? {
        let xa = chatLeft + pt(64), xb = chatRight - pt(64)
        guard xb > xa, y1 > y0 else { return nil }
        var top: Int? = nil, bottom = 0, gap = 0, minX = Int.max, maxX = Int.min, cut = true
        var rows: [Int: (Int, Int)] = [:]
        var y = max(0, y0)
        while y < min(y1, H) {
            var lo = Int.max, hi = Int.min
            var x = xa
            while x <= xb { if bmp.px(x, y).dist(chatBg) > 12 { if lo == Int.max { lo = x }; hi = x }; x += 3 }
            if hi >= lo {
                if top == nil { top = y }
                bottom = y; gap = 0; minX = min(minX, lo); maxX = max(maxX, hi); rows[y] = (lo, hi)
            } else if top != nil {
                gap += 1
                if gap >= pt(6) { cut = false; break }
            }
            y += 1
        }
        guard let t = top, bottom - t >= pt(10), maxX - minX >= pt(10) else { return nil }
        return (minX, t, maxX - minX + 3, bottom - t + 1, rows, cut && bottom >= y1 - 2)
    }
    /// A text bubble has a flat fill (green for self, white / dark grey for others) just inside its top edge,
    /// where glyphs never reach; an image does not.
    func isTextBubble(side: String, box b: (x: Int, y: Int, w: Int, h: Int, rows: [Int: (Int, Int)], cut: Bool), lines: [Line]) -> Bool {
        if let firstY = lines.map({ $0.y }).min() {
            // Enlarged short messages (big font) have a taller top padding, so allow a share of the bubble height.
            guard firstY - Double(b.y) <= max(Double(pt(18)), Double(b.h) * 0.35) else { return false }
        } else if b.h > pt(90) {
            return false // no text found: only a small bubble can still be a text bubble OCR missed (e.g. "……")
        }
        var pts: [(Int, Int)] = []
        for dy in [pt(3), pt(6)] {
            guard let r = b.rows[b.y + dy], r.1 - r.0 > pt(24) else { continue }
            let (lo, hi) = r
            for i in 0..<12 { pts.append((lo + pt(10) + (hi - lo - pt(20)) * i / 11, b.y + dy)) }
        }
        guard pts.count >= 12 else { return false }
        let (c, share) = bmp.mode(pts)
        if share < 0.85 { return false }
        if side == "self" { return c.isGreen }
        return dark ? (c.lum >= 28 && c.lum <= 95) : c.lum >= 232
    }

    /// "……" / "…" when the bubble holds only a row of small, equal, evenly spaced dots on one baseline.
    func dotsText(_ b: (x: Int, y: Int, w: Int, h: Int, rows: [Int: (Int, Int)], cut: Bool)) -> String? {
        let inset = pt(6)
        let fill = bmp.mode((0..<10).map { (b.x + inset + (b.w - 2 * inset) * $0 / 9, b.y + pt(3)) }).0
        var cols: [Int: (Int, Int)] = [:] // x → (minY, maxY) of glyph pixels
        for x in (b.x + inset)..<(b.x + b.w - inset) {
            for y in (b.y + pt(4))..<(b.y + b.h - pt(4)) where bmp.px(x, y).dist(fill) > 60 {
                let c = cols[x] ?? (y, y)
                cols[x] = (min(c.0, y), max(c.1, y))
            }
        }
        guard !cols.isEmpty else { return nil }
        var blobs: [(x0: Int, x1: Int, y0: Int, y1: Int)] = []
        for x in cols.keys.sorted() {
            let c = cols[x]!
            if let l = blobs.last, x <= l.x1 + 1 { blobs[blobs.count - 1] = (l.x0, x, min(l.y0, c.0), max(l.y1, c.1)) }
            else { blobs.append((x, x, c.0, c.1)) }
        }
        guard (2...12).contains(blobs.count) else { return nil }
        let ws = blobs.map { $0.x1 - $0.x0 + 1 }, hs = blobs.map { $0.y1 - $0.y0 + 1 }
        guard ws.max()! <= pt(4), hs.max()! <= pt(4), ws.max()! - ws.min()! <= 2, hs.max()! - hs.min()! <= 2 else { return nil }
        let mids = blobs.map { $0.y0 + $0.y1 }
        guard mids.max()! - mids.min()! <= 4 else { return nil }
        let gaps = zip(blobs.dropFirst(), blobs).map { $0.x0 - $1.x0 }
        guard gaps.max()! - gaps.min()! <= 3 else { return nil }
        return String(repeating: "…", count: max(1, blobs.count / 3))
    }

    // Lines not belonging to any avatar's block that are centred → time / system notices.
    for (i, a) in avs.enumerated() {
        let nextTop = i + 1 < avs.count ? Double(avs[i + 1].top) - 2 : Double(areaBottom)
        let top = Double(a.top) - Double(pt(4))
        var texts: [String] = []
        var textLines: [Line] = []
        var sender: String? = nil
        var senderBottom: Double? = nil
        var blockBottom = Double(a.bottom)
        for (li, l) in msgLines.enumerated() where !used.contains(li) && l.midY >= top && l.midY < nextTop {
            let isSelfSide = l.midX > chatMid || (a.side == "self" && l.maxX > chatMid)
            if (a.side == "self") != isSelfSide && abs(l.midX - chatMid) > chatW * 0.08 { continue }
            let centred = abs(l.midX - chatMid) < chatW * 0.12 && bubbleColor(l) == nil
            if centred && !(a.side == "other" && l.x < chatMid - chatW * 0.2) { continue }
            let bc = bubbleColor(l)
            if bc == nil && a.side == "other" && texts.isEmpty && sender == nil && l.midY < Double(a.top) + Double(pt(20)) {
                sender = l.text; senderBottom = l.maxY; used.insert(li); continue
            }
            if bc == nil && isTimeLike(l.text) { continue }
            texts.append(l.text); textLines.append(l); used.insert(li); blockBottom = max(blockBottom, l.maxY)
        }
        if a.side == "other" && sender != nil { isGroup = true }
        let y0 = senderBottom.map { Int($0) + 1 } ?? a.top - pt(2)
        let cb = contentBox(from: y0, to: Int(nextTop))
        let partial = a.top <= areaTop + 1 || (cb?.cut == true && Int(nextTop) >= areaBottom - 2)
        if !texts.isEmpty && texts.allSatisfy(isNoise) { continue }
        var kind = texts.isEmpty ? "media" : "text"
        var text = texts.isEmpty ? "[非文本消息]" : texts.joined(separator: "\n")
        if let b = cb, !isTextBubble(side: a.side, box: b, lines: textLines) {
            kind = "image"
            text = texts.isEmpty ? "[图片]" : "[图片] " + texts.joined(separator: " ")
        } else if let b = cb, texts.isEmpty {
            // A text bubble whose glyphs OCR missed at screen size (short / punctuation-only text): read it zoomed in,
            // and recognise a row of dots (……) from the pixels, since Vision never reports punctuation-only lines.
            let t = ocrRegion(bmp.cg, CGRect(x: b.x, y: b.y, width: b.w, height: b.h))
            kind = "text"
            text = !t.isEmpty && !t.allSatisfy({ "•·.。…⋯ ".contains($0) }) ? t : (dotsText(b) ?? (t.isEmpty ? "[表情/符号]" : "……"))
        }
        if let b = cb { blockBottom = max(blockBottom, Double(b.y + b.h)) }
        messages.append(Message(side: a.side, sender: sender, text: text, kind: kind, top: Double(a.top), bottom: blockBottom, partial: partial,
                                box: cb.map { Box(x: Double($0.x), y: Double($0.y), w: Double($0.w), h: Double($0.h)) }))
    }
    // Orphan lines: time stamps / system notices / text of a message whose avatar is scrolled off.
    for (li, l) in msgLines.enumerated() where !used.contains(li) && !isNoise(l.text) {
        let centred = abs(l.midX - chatMid) < chatW * 0.15
        if centred && bubbleColor(l) == nil {
            messages.append(Message(side: "system", sender: nil, text: l.text, kind: isTimeLike(l.text) ? "time" : "system",
                                    top: l.y, bottom: l.maxY, partial: false))
        } else if let first = avs.first, l.midY < Double(first.top) {
            let side = bubbleColor(l)?.isGreen == true || l.midX > chatMid ? "self" : "other"
            if let last = messages.firstIndex(where: { $0.partial && $0.top < Double(first.top) && $0.side == side && $0.kind != "time" }) {
                messages[last].text += "\n" + l.text
            } else {
                messages.append(Message(side: side, sender: nil, text: l.text, kind: "text", top: l.y, bottom: l.maxY, partial: true))
            }
        }
    }
    messages.sort { $0.top < $1.top }
    // Merge consecutive orphan fragments of the same partial message.
    var compact: [Message] = []
    for m in messages {
        if var last = compact.last, last.partial, m.partial, last.side == m.side, last.kind == "text", m.kind == "text", m.top - last.bottom < Double(pt(16)) {
            last.text += "\n" + m.text; last.bottom = m.bottom; compact[compact.count - 1] = last
        } else { compact.append(m) }
    }

    // --- Sessions list.
    var sessions: [Session] = []
    let listW = Double(listRight - listLeft)
    let timeLines = listLines.filter { isTimeLike($0.text) && $0.x > Double(listLeft) + listW * 0.6 && $0.y > Double(pt(44)) }
    for t in timeLines.sorted(by: { $0.y < $1.y }) {
        guard let name = listLines.filter({ abs($0.midY - t.midY) < max(t.h, $0.h) * 0.8 && $0.maxX < t.x && $0.x > Double(listLeft) + listW * 0.12 })
                .min(by: { $0.x < $1.x }) else { continue }
        let preview = listLines.filter { $0.y > name.maxY - 2 && $0.y < name.maxY + name.h * 1.6 && abs($0.x - name.x) < listW * 0.12 }
            .sorted(by: { $0.x < $1.x }).map { $0.text }.joined(separator: " ")
        let rowH = Double(pt(64))
        let top = name.y - Double(pt(12)), bottom = top + rowH
        // Unread badge: red pixels around the avatar's top-right corner.
        var red = 0
        let ax0 = listLeft + pt(4), ax1 = Int(name.x) - pt(2)
        for y in stride(from: Int(top), to: Int(top + rowH * 0.6), by: 1) {
            for x in stride(from: ax0, to: max(ax0, ax1), by: 1) where bmp.px(x, y).isRed { red += 1 }
        }
        let rowBg = bmp.mode((0..<8).map { (listRight - pt(6), Int(name.y) + $0 * Int(name.h) / 8) }).0
        let selected = rowBg.isGreen
        let mentioned = preview.contains("有人@我") || preview.contains("@所有人") || preview.contains("[有人@我]")
        sessions.append(Session(name: name.text, preview: preview, time: t.text, x: Double(listLeft) + listW / 2, y: name.midY + Double(pt(8)),
                                top: top, bottom: bottom, unread: red >= pt(6) * pt(6) / 2, selected: selected, mentioned: mentioned))
    }

    let layout = Layout(sidebarRight: sidebarRight, listLeft: listLeft, listRight: listRight, chatLeft: chatLeft, chatRight: chatRight,
                        headerBottom: headerBottom, inputTop: inputTop, input: inputPoint, send: sendPoint, dark: dark,
                        chatBg: [chatBg.r, chatBg.g, chatBg.b])
    return Result(ok: true, error: nil, width: W, height: H, scale: s, layout: layout, title: title, isGroup: isGroup,
                  sessions: sessions, messages: compact, lines: lines, ms: Int(Date().timeIntervalSince(t0) * 1000))
}

// MARK: - Crop

struct CropReq: Decodable { var image: String; var x: Double; var y: Double; var w: Double; var h: Double; var out: String; var maxDim: Int?; var quality: Double? }
struct CropResult: Encodable { var ok: Bool; var error: String?; var width: Int; var height: Int; var bytes: Int; var std: Double = 0 }

/// Crops a region of a screenshot, downsizes it so the longer side is at most `maxDim` and writes a JPEG.
func crop(_ r: CropReq) -> CropResult {
    let fail = { (e: String) in CropResult(ok: false, error: e, width: 0, height: 0, bytes: 0) }
    guard let img = NSImage(contentsOfFile: r.image) else { return fail("cannot read image") }
    var rect = CGRect(origin: .zero, size: img.size)
    guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return fail("cannot decode image") }
    let area = CGRect(x: r.x, y: r.y, width: r.w, height: r.h).integral.intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    guard !area.isEmpty, let part = cg.cropping(to: area) else { return fail("empty crop") }
    let maxDim = Double(max(64, r.maxDim ?? 768))
    let k = min(1, maxDim / Double(max(part.width, part.height)))
    let w = max(1, Int(Double(part.width) * k)), h = max(1, Int(Double(part.height) * k))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return fail("no context") }
    ctx.interpolationQuality = .high
    ctx.draw(part, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let scaled = ctx.makeImage(),
          let data = NSBitmapImageRep(cgImage: scaled).representation(using: .jpeg, properties: [.compressionFactor: r.quality ?? 0.7]) else { return fail("encode failed") }
    do { try data.write(to: URL(fileURLWithPath: r.out)) } catch { return fail("write failed: \(error)") }
    return CropResult(ok: true, error: nil, width: w, height: h, bytes: data.count, std: lumaStd(scaled))
}

// MARK: - Entry

let enc = JSONEncoder()
func emit<T: Encodable>(_ v: T) {
    if let d = try? enc.encode(v), let s = String(data: d, encoding: .utf8) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
}

// MARK: - Clipboard (save every item/type, put text, restore unless someone else wrote meanwhile)

struct ClipReq: Decodable { var op: String; var text: String? }
struct ClipResult: Encodable { var ok: Bool; var error: String?; var restored: Bool? }

var savedClip: [[(NSPasteboard.PasteboardType, Data)]]? = nil
var ourChangeCount = -1

func clipboard(_ r: ClipReq) -> ClipResult {
    let pb = NSPasteboard.general
    switch r.op {
    case "save":
        savedClip = (pb.pasteboardItems ?? []).map { item in item.types.compactMap { t in item.data(forType: t).map { (t, $0) } } }
        return ClipResult(ok: true, error: nil, restored: nil)
    case "set":
        pb.clearContents()
        pb.setString(r.text ?? "", forType: .string)
        // Ask clipboard managers not to record this temporary value.
        pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        ourChangeCount = pb.changeCount
        return ClipResult(ok: true, error: nil, restored: nil)
    case "restore":
        defer { savedClip = nil; ourChangeCount = -1 }
        guard let saved = savedClip else { return ClipResult(ok: false, error: "nothing saved", restored: false) }
        // The user (or another app) copied something after we did: keep theirs.
        if ourChangeCount >= 0 && pb.changeCount != ourChangeCount { return ClipResult(ok: true, error: nil, restored: false) }
        pb.clearContents()
        let items: [NSPasteboardItem] = saved.map { pairs in
            let it = NSPasteboardItem()
            for (t, d) in pairs { it.setData(d, forType: t) }
            return it
        }
        if !items.isEmpty { pb.writeObjects(items) }
        return ClipResult(ok: true, error: nil, restored: true)
    default:
        return ClipResult(ok: false, error: "unknown op \(r.op)", restored: nil)
    }
}

// MARK: - Window list (WeChat's search popup is a separate, non-main window) and row brightness

struct WinReq: Decodable { var pid: Int32 }
struct WinInfo: Encodable { var id: Int; var layer: Int; var x: Double; var y: Double; var w: Double; var h: Double; var name: String? }

func windows(_ r: WinReq) -> [WinInfo] {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    return list.compactMap { w in
        guard (w[kCGWindowOwnerPID as String] as? Int32) == r.pid, let id = w[kCGWindowNumber as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Double] else { return nil }
        return WinInfo(id: id, layer: (w[kCGWindowLayer as String] as? Int) ?? 0, x: b["X"] ?? 0, y: b["Y"] ?? 0,
                       w: b["Width"] ?? 0, h: b["Height"] ?? 0, name: w[kCGWindowName as String] as? String)
    }
}

/** Mean luminance of an 8px strip starting at (x, y) for every y: used to find the highlighted row of a list. */
struct LumaReq: Decodable { var image: String; var x: Int; var ys: [Double] }

func luma(_ r: LumaReq) -> [Int] {
    guard let bmp = Bitmap(path: r.image) else { return [] }
    return r.ys.map { y in
        (0..<8).map { bmp.px(r.x + $0, Int(y)).lum }.reduce(0, +) / 8
    }
}

struct Req: Decodable { var id: Int; var image: String?; var scale: Double?; var crop: CropReq?; var clip: ClipReq?; var windows: WinReq?; var luma: LumaReq?; var ocr: OcrReq? }
struct Resp: Encodable {
    var id: Int; var result: Result?; var crop: CropResult?; var clip: ClipResult? = nil
    var windows: [WinInfo]? = nil; var luma: [Int]? = nil; var ocr: OcrResult? = nil
}

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "--serve" {
    setvbuf(stdout, nil, _IONBF, 0)
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let req = try? JSONDecoder().decode(Req.self, from: data) else { continue }
        autoreleasepool {
            if let c = req.clip { emit(Resp(id: req.id, result: nil, crop: nil, clip: clipboard(c))) }
            else if let w = req.windows { emit(Resp(id: req.id, result: nil, crop: nil, windows: windows(w))) }
            else if let l = req.luma { emit(Resp(id: req.id, result: nil, crop: nil, luma: luma(l))) }
            else if let o = req.ocr { emit(Resp(id: req.id, result: nil, crop: nil, ocr: ocrFile(o))) }
            else if let c = req.crop { emit(Resp(id: req.id, result: nil, crop: crop(c))) }
            else if let image = req.image { emit(Resp(id: req.id, result: analyze(path: image, scaleHint: req.scale), crop: nil)) }
        }
    }
} else if args.count >= 2 {
    emit(analyze(path: args[1], scaleHint: args.count >= 3 ? Double(args[2]) : nil))
} else {
    FileHandle.standardError.write("usage: wx-vision <image> [scale] | --serve\n".data(using: .utf8)!)
    exit(2)
}
