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
func lumaStd(_ cg: CGImage) -> Double { lumaStats(cg).std }

/// Luminance spread plus the share of pixels within ~one luminance bucket of the dominant one (≈ 1 for a flat grey
/// "loading" placeholder, even with a small spinner / play icon on it).
func lumaStats(_ cg: CGImage) -> (std: Double, flat: Double) {
    let w = 64, h = 64
    var data = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return (0, 1) }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    var sum = 0.0, sq = 0.0
    var bins = [Int](repeating: 0, count: 33)
    for i in stride(from: 0, to: data.count, by: 4) {
        let l = (Double(data[i]) * 3 + Double(data[i + 1]) * 6 + Double(data[i + 2])) / 10
        sum += l; sq += l * l
        bins[Int(l) / 8] += 1
    }
    let n = Double(w * h), m = sum / n
    var best = 0
    for b in 0..<32 { best = max(best, bins[b] + bins[b + 1]) }
    return ((max(0, sq / n - m * m)).squareRoot(), Double(best) / n)
}

struct OcrReq: Decodable { var image: String }
struct OcrResult: Encodable { var ok: Bool; var text: String; var width: Int; var height: Int; var std: Double; var flat: Double = 0 }

func ocrFile(_ r: OcrReq) -> OcrResult {
    guard let img = NSImage(contentsOfFile: r.image) else { return OcrResult(ok: false, text: "", width: 0, height: 0, std: 0) }
    var rect = CGRect(origin: .zero, size: img.size)
    guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return OcrResult(ok: false, text: "", width: 0, height: 0, std: 0) }
    let st = lumaStats(cg)
    return OcrResult(ok: true, text: ocrRegion(cg, CGRect(x: 0, y: 0, width: cg.width, height: cg.height), upscale: 3),
                     width: cg.width, height: cg.height, std: st.std, flat: st.flat)
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
    // OCR reads the pill's arrow icon as a stray symbol ("^3条新消息"): keep only letters, digits, CJK and @.
    let t = s.filter { $0.isLetter || $0.isNumber || $0 == "@" }
    return t.range(of: #"^(有)?\d+条(新|未读)?消息$"#, options: .regularExpression) != nil
        || ["以下为新消息", "以下是新消息", "回到最新", "回到底部", "查看最新消息"].contains(t)
        || t.range(of: #"^\d+条@?我?的?消息$"#, options: .regularExpression) != nil
}

/// Joins OCR lines top to bottom; lines sharing a row are joined left to right with a space.
func joinLines(_ ls: [Line]) -> String {
    var rows: [[Line]] = []
    for l in ls.sorted(by: { $0.midY < $1.midY }) {
        if let last = rows.last?.last, abs(last.midY - l.midY) < min(last.h, l.h) * 0.5 { rows[rows.count - 1].append(l) } else { rows.append([l]) }
    }
    return rows.map { $0.sorted { $0.x < $1.x }.map { $0.text }.joined(separator: " ") }.joined(separator: "\n")
}

func analyze(path: String, scaleHint: Double?) -> Result {
    let t0 = Date()
    guard let bmp = Bitmap(path: path) else {
        return Result(ok: false, error: "cannot read image", width: 0, height: 0, scale: 0, layout: nil, title: nil, isGroup: false, sessions: [], messages: [], lines: [], ms: 0)
    }
    let W = bmp.w, H = bmp.h
    let s = scaleHint ?? 2.0              // screenshot pixels per point
    func pt(_ v: Double) -> Int { Int((v * s).rounded()) }

    // --- Columns. The sidebar | list | chat splits are vertical colour edges present on (almost) every row, whatever
    // the theme, the selected row or the chat content (bubbles only cover some rows).
    let edgeYs = Array(stride(from: Int(Double(H) * 0.1), to: Int(Double(H) * 0.95), by: 2))
    var edgeCache: [Int: Double] = [:]
    func edgeShare(_ x: Int) -> Double {
        if let v = edgeCache[x] { return v }
        var n = 0
        for y in edgeYs where bmp.px(x - 2, y).dist(bmp.px(x + 2, y)) >= 5 { n += 1 }
        let v = Double(n) / Double(max(1, edgeYs.count))
        edgeCache[x] = v
        return v
    }
    /// Centre of the strongest edge plateau in [a, b] (nil if no column has an edge on most rows).
    func strongestEdge(_ a: Int, _ b: Int) -> Int? {
        guard b > a else { return nil }
        var bx = a, bv = 0.0
        for x in a...b { let v = edgeShare(x); if v > bv + 0.001 { bx = x; bv = v } }
        guard bv >= 0.7 else { return nil }
        var hi = bx
        while hi + 1 <= b && edgeShare(hi + 1) >= bv - 0.03 { hi += 1 }
        return (bx + hi) / 2 + 1
    }
    let sidebarRight = strongestEdge(pt(30), min(W / 3, pt(110))) ?? pt(60)
    let listRight = strongestEdge(sidebarRight + pt(150), Int(Double(W) * 0.7)) ?? Int(Double(W) * 0.35)
    let listLeft = sidebarRight, chatLeft = listRight

    // Chat background: the most common colour of the chat column.
    var bgPts: [(Int, Int)] = []
    for y in stride(from: pt(60), to: H - pt(8), by: pt(5)) { for x in stride(from: chatLeft + pt(4), to: W - pt(12), by: pt(5)) { bgPts.append((x, y)) } }
    let chatBg = bmp.mode(bgPts).0
    let dark = chatBg.lum < 100
    // Right edge of the chat column (window border / shadow excluded).
    var chatRight = W - 1
    while chatRight > W - pt(30) {
        let same = edgeYs.filter { bmp.px(chatRight, $0).dist(chatBg) <= 3 }.count
        if Double(same) >= Double(edgeYs.count) * 0.5 { break }
        chatRight -= 1
    }
    let chatW = Double(chatRight - chatLeft), chatMid = Double(chatLeft + chatRight) / 2

    let lines = (try? ocr(bmp)) ?? []
    let chatLines = lines.filter { $0.x >= Double(chatLeft) - 2 }
    let listLines = lines.filter { $0.x >= Double(listLeft) - 2 && $0.maxX <= Double(listRight) + 4 }

    // --- Header: a full-width separator line under the title.
    var headerBottom = pt(52)
    do {
        let xs = Array(stride(from: chatLeft + pt(20), to: chatRight - pt(20), by: 4))
        for y in pt(30)..<min(H / 3, pt(90)) {
            let diff = xs.filter { bmp.px($0, y).dist(chatBg) >= 4 }.count
            if Double(diff) >= Double(xs.count) * 0.9 {
                var e = y
                while e < y + pt(3) && Double(xs.filter { bmp.px($0, e + 1).dist(chatBg) >= 4 }.count) >= Double(xs.count) * 0.9 { e += 1 }
                headerBottom = e + 1
                break
            }
        }
    }
    let titleLine = chatLines.filter { $0.maxY <= Double(headerBottom) + 2 && $0.x < Double(chatLeft) + chatW * 0.6 }.min(by: { $0.x < $1.x })
    var title = titleLine?.text
    var isGroup = false
    if let t = title, let r = t.range(of: #"\s*[（(]\d+[)）]\s*$"#, options: .regularExpression) {
        isGroup = true; title = String(t[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
    }

    // --- Input box: a bordered box (light and dark) above the 发送/Send button.
    // OCR sometimes merges the button's icon into the label ("③发送"): accept up to 3 stray symbol characters before it.
    func sendLabel(_ l: Line) -> String? {
        let t = l.text.trimmingCharacters(in: .whitespaces)
        for k in ["发送", "Send", "發送"] where t.hasSuffix(k) {
            let prefix = t.dropLast(k.count)
            if prefix.count <= 3 && prefix.allSatisfy({ !$0.isLetter && !$0.isNumber || "①②③④⑤⑥⑦⑧⑨".contains($0) }) { return k }
        }
        return nil
    }
    let sendLine = chatLines.filter { sendLabel($0) != nil && $0.y > Double(H) * 0.5 }.max(by: { $0.y < $1.y })
        .map { l -> Line in
            // Centre on the label itself, not on the icon + label.
            let t = l.text.trimmingCharacters(in: .whitespaces), k = sendLabel(l)!
            guard t.count > k.count else { return l }
            var m = l; m.w = l.w * Double(k.count) / Double(t.count); m.x = l.maxX - m.w
            return m
        }
    var inputTop = Int(Double(H) * 0.75)
    do {
        let xs = Array(stride(from: chatLeft + pt(30), to: chatRight - pt(30), by: 3))
        var y = sendLine.map { Int($0.y) - pt(70) } ?? H - pt(80)
        while y > Int(Double(H) * 0.4) {
            let diff = xs.filter { bmp.px($0, y).dist(chatBg) >= 4 }.count
            if Double(diff) >= Double(xs.count) * 0.9 { inputTop = y; break }
            y -= 1
        }
        if y <= Int(Double(H) * 0.4), let sl = sendLine { inputTop = Int(sl.y) - pt(110) }
    }
    let inputPoint = Point(x: Double(chatLeft + (chatRight - chatLeft) / 2), y: Double(inputTop + pt(40)))
    let sendPoint = sendLine.map { Point(x: $0.midX, y: $0.midY) }

    let areaTop = headerBottom, areaBottom = inputTop - pt(1)
    func fg(_ x: Int, _ y: Int, _ t: Int = 4) -> Bool { bmp.px(x, y).dist(chatBg) > t }

    // --- Avatars (36pt squares ~20pt from either chat edge) start every message.
    struct Avatar { var side: String; var top: Int; var bottom: Int }
    func avatars(_ x0: Int, _ x1: Int, side: String) -> [Avatar] {
        var out: [Avatar] = []
        var st: Int? = nil, last = 0
        func close() {
            guard let a = st else { return }
            let len = last - a + 1
            let edge = a <= areaTop + 1 || last >= areaBottom - 2
            if len <= pt(46) && (len >= pt(28) || (edge && len >= pt(4))) { out.append(Avatar(side: side, top: a, bottom: last + 1)) }
            st = nil
        }
        for y in areaTop..<max(areaTop, areaBottom) {
            var n = 0, x = x0
            while x <= x1 { if fg(x, y) { n += 1 }; x += 2 }
            if n >= 3 { if st == nil { st = y }; last = y }
            else if st != nil && y - last > pt(4) { close() }
        }
        close()
        return out
    }
    let avL = avatars(chatLeft + pt(18), chatLeft + pt(58), side: "other")
    let avR = avatars(chatRight - pt(58), chatRight - pt(18), side: "self")

    // --- Content blocks between the avatar columns: connected non-background regions (on a coarse grid), merged when
    // they sit side by side on the same rows (glyphs of one line). Unrelated things on the same rows (the mouse
    // pointer, which the window capture includes) stay separate.
    struct Block { var top: Int; var bottom: Int; var x0: Int; var x1: Int; var fill: RGB?; var lines: [Line] }
    let xa = chatLeft + pt(62), xb = chatRight - pt(62)
    var blocks: [Block] = []
    do {
        let c = max(2, pt(2))
        let gw = max(0, (xb - xa) / c), gh = max(0, (areaBottom - areaTop) / c)
        var cell = [Bool](repeating: false, count: gw * gh)
        for gy in 0..<gh {
            for gx in 0..<gw {
                let x0 = xa + gx * c, y0 = areaTop + gy * c
                var hit = false
                for yy in y0..<(y0 + c) where !hit { for xx in x0..<(x0 + c) where fg(xx, yy) { hit = true; break } }
                cell[gy * gw + gx] = hit
            }
        }
        var parent = Array(0..<(gw * gh))
        func find(_ i: Int) -> Int { var i = i; while parent[i] != i { parent[i] = parent[parent[i]]; i = parent[i] }; return i }
        for gy in 0..<gh {
            for gx in 0..<gw where cell[gy * gw + gx] {
                let i = gy * gw + gx
                for (dx, dy) in [(-1, 0), (-1, -1), (0, -1), (1, -1)] {
                    let nx = gx + dx, ny = gy + dy
                    if nx >= 0 && nx < gw && ny >= 0 && cell[ny * gw + nx] { let a = find(i), b = find(ny * gw + nx); if a != b { parent[a] = b } }
                }
            }
        }
        var comp: [Int: Block] = [:]
        for gy in 0..<gh {
            for gx in 0..<gw where cell[gy * gw + gx] {
                let r = find(gy * gw + gx)
                let x = xa + gx * c, y = areaTop + gy * c
                if var b = comp[r] { b.x0 = min(b.x0, x); b.x1 = max(b.x1, x + c - 1); b.top = min(b.top, y); b.bottom = max(b.bottom, y + c); comp[r] = b }
                else { comp[r] = Block(top: y, bottom: y + c, x0: x, x1: x + c - 1, fill: nil, lines: []) }
            }
        }
        blocks = Array(comp.values)
        var changed = true
        while changed {
            changed = false
            blocks.sort { $0.top < $1.top }
            outer: for a in 0..<blocks.count {
                for b in (a + 1)..<blocks.count {
                    let p = blocks[a], q = blocks[b]
                    let vGap = max(p.top, q.top) - min(p.bottom, q.bottom)
                    let hGap = max(p.x0, q.x0) - min(p.x1, q.x1)
                    if vGap <= pt(2) && hGap <= pt(24) {
                        blocks[a] = Block(top: min(p.top, q.top), bottom: max(p.bottom, q.bottom), x0: min(p.x0, q.x0), x1: max(p.x1, q.x1), fill: nil, lines: [])
                        blocks.remove(at: b); changed = true; break outer
                    }
                }
            }
        }
        // Clamp to the area so the top / bottom tests below are exact.
        blocks = blocks.map { var b = $0; b.top = max(b.top, areaTop); b.bottom = min(b.bottom, areaBottom); return b }
    }
    blocks = blocks.filter { $0.bottom - $0.top >= pt(4) || $0.top <= areaTop + 1 || $0.bottom >= areaBottom - 1 }
    /// Flat bubble fill: green for self, a neutral grey a bit darker (light theme) / lighter (dark theme) than the background.
    func bubbleFill(_ b: Block) -> RGB? {
        let m = pt(2)
        guard b.x1 - b.x0 > 2 * m + pt(6), b.bottom - b.top > 2 * m + pt(6) else { return nil }
        var pts: [(Int, Int)] = []
        let rows = max(4, (b.bottom - b.top) / pt(5))
        for i in 0..<rows { for j in 0..<16 { pts.append((b.x0 + m + (b.x1 - b.x0 - 2 * m) * j / 15, b.top + m + (b.bottom - b.top - 2 * m) * i / (rows - 1))) } }
        let (c, share) = bmp.mode(pts)
        guard share >= 0.45, c.dist(chatBg) > 4 else { return nil }
        if c.isGreen { return c }
        let neutral = abs(c.r - c.g) <= 8 && abs(c.g - c.b) <= 8
        let d = c.lum - chatBg.lum
        if neutral && (dark ? (d >= 5 && d <= 60) : (d <= -5 && d >= -45)) { return c }
        return nil
    }
    for i in blocks.indices {
        let b = blocks[i]
        blocks[i].fill = bubbleFill(b)
        blocks[i].lines = chatLines.filter { $0.midY >= Double(b.top) - 2 && $0.midY <= Double(b.bottom) + 2 && $0.midX >= Double(b.x0) - 2 && $0.midX <= Double(b.x1) + 2 }
    }

    // The window capture includes the mouse pointer: a small textless, fill-less blob away from both bubble columns.
    blocks = blocks.filter { b in
        // "3条新消息" / "回到最新" pills float over the chat.
        if b.fill == nil, !b.lines.isEmpty, isNoise(joinLines(b.lines)) { return false }
        return !(b.fill == nil && b.lines.isEmpty && b.x0 > chatLeft + pt(80) && b.x1 < chatRight - pt(80) && b.x1 - b.x0 < pt(40) && b.bottom - b.top < pt(40))
    }

    /// "……" / "…" when the bubble holds only a row of small, equal, evenly spaced dots on one baseline.
    func dotsText(_ b: Block, fill: RGB) -> String? {
        let inset = pt(6)
        var cols: [Int: (Int, Int)] = [:]
        for x in (b.x0 + inset)..<max(b.x0 + inset, b.x1 - inset) {
            for y in (b.top + pt(4))..<max(b.top + pt(4), b.bottom - pt(4)) where bmp.px(x, y).dist(fill) > 60 {
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

    // --- Blocks → messages. Bubbles / images hug the avatar side (70pt from the edge); centred bare text is a time
    // stamp or system notice; a small bare line right above a left bubble at an avatar's top is a group sender name.
    struct Draft { var side: String; var sender: String?; var parts: [(Block, String)]; var top: Int; var bottom: Int; var partial: Bool }
    var drafts: [Draft] = []
    var system: [Message] = []
    var usedAv = Set<String>()
    var cur: Int? = nil
    var senderCount = 0
    func alignedLeft(_ b: Block) -> Bool { b.x0 <= chatLeft + pt(80) }
    func alignedRight(_ b: Block) -> Bool { b.x1 >= chatRight - pt(80) }
    var i = 0
    while i < blocks.count {
        let b = blocks[i]
        defer { i += 1 }
        let text = joinLines(b.lines)
        let al = alignedLeft(b), ar = alignedRight(b)
        let centred = !al && !ar && abs(Double(b.x0 - chatLeft) - Double(chatRight - b.x1)) < Double(pt(24))
        if b.fill == nil && (centred || (al && ar && !b.lines.isEmpty && b.bottom - b.top <= pt(24))) {
            cur = nil
            if !text.isEmpty && !isNoise(text) {
                system.append(Message(side: "system", sender: nil, text: text.replacingOccurrences(of: "\n", with: " "), kind: isTimeLike(text) ? "time" : "system",
                                      top: Double(b.top), bottom: Double(b.bottom), partial: false))
            }
            continue
        }
        if !text.isEmpty && isNoise(text) { continue }
        // Bare, textless and detached from both bubble columns: the mouse pointer or another overlay.
        if b.fill == nil && b.lines.isEmpty && !al && !ar { continue }
        let side: String
        if al && !ar { side = "other" } else if ar && !al { side = "self" }
        else if b.fill?.isGreen == true { side = "self" }
        else if avR.contains(where: { $0.top < b.bottom && $0.bottom > b.top }) { side = "self" }
        else if avL.contains(where: { $0.top < b.bottom && $0.bottom > b.top }) { side = "other" }
        else { side = Double(b.x0 + b.x1) / 2 > chatMid ? "self" : "other" }
        let avs = side == "self" ? avR : avL
        let av = avs.first { !usedAv.contains("\(side)\($0.top)") && $0.top >= b.top - pt(8) && $0.top <= b.top + pt(10) }
        // Every message has its own avatar, so a block without one belongs to the message above (bubble under a sender
        // name, quoted message, sticker parts) unless a time stamp / the other side came in between.
        let continues = av == nil && cur != nil && drafts[cur!].side == side
        if !continues {
            if let a = av { usedAv.insert("\(side)\(a.top)") }
            drafts.append(Draft(side: side, sender: nil, parts: [], top: min(b.top, av?.top ?? b.top), bottom: max(b.bottom, av?.bottom ?? 0),
                                partial: b.top <= areaTop + 1 || (av?.top ?? Int.max) <= areaTop + 1))
            cur = drafts.count - 1
            // Group sender name: one small bare line, followed closely by this sender's bubble / image.
            if side == "other", b.fill == nil, !text.isEmpty, !text.contains("\n"), b.bottom - b.top <= pt(22),
               let n = blocks[(i + 1)...].first(where: { alignedLeft($0) && !alignedRight($0) }) {
                if n.top - b.bottom <= pt(12) {
                    drafts[cur!].sender = text
                    if av != nil { senderCount += 1 }
                    continue
                }
            }
        }
        drafts[cur!].parts.append((b, text))
        drafts[cur!].bottom = max(drafts[cur!].bottom, b.bottom)
    }

    var messages: [Message] = system
    /// A quoted message under a bubble: bare text with a thin vertical bar on its left edge.
    func isQuote(_ b: Block) -> Bool {
        let h = b.bottom - b.top
        guard b.fill == nil, h >= pt(16), h <= pt(90) else { return false }
        var bar = 0, gapClear = 0
        for y in b.top..<b.bottom {
            if (b.x0..<(b.x0 + pt(3))).contains(where: { fg($0, y) }) { bar += 1 }
            if !((b.x0 + pt(4))..<(b.x0 + pt(9))).contains(where: { fg($0, y) }) { gapClear += 1 }
        }
        return Double(bar) >= Double(h) * 0.8 && Double(gapClear) >= Double(h) * 0.8
    }
    for d in drafts where !d.parts.isEmpty {
        var texts: [String] = [], kind = "", box: Block? = nil, imageText: [String] = [], quotes: [String] = []
        for (b, t) in d.parts {
            if isQuote(b) {
                quotes.append("[引用] " + (t.isEmpty ? "[图片]" : t.replacingOccurrences(of: "\n", with: " ")))
            } else if let f = b.fill {
                var tt = t
                if tt.isEmpty {
                    // Short / punctuation-only text OCR missed at screen size: read it zoomed in, or recognise a row of dots.
                    let z = ocrRegion(bmp.cg, CGRect(x: b.x0, y: b.top, width: b.x1 - b.x0, height: b.bottom - b.top))
                    tt = !z.isEmpty && !z.allSatisfy({ "•·.。…⋯ ".contains($0) }) ? z : (dotsText(b, fill: f) ?? (z.isEmpty ? "[表情]" : "……"))
                }
                texts.append(tt)
                if kind != "text" { kind = "text"; box = b }
            } else if kind == "text" && !t.isEmpty && b.bottom - b.top <= pt(48) {
                texts.append("[引用] " + t.replacingOccurrences(of: "\n", with: " ")) // quoted message under a bubble
            } else {
                if kind == "" { kind = "image"; box = b }
                else if kind == "image", let bb = box { box = Block(top: bb.top, bottom: b.bottom, x0: min(bb.x0, b.x0), x1: max(bb.x1, b.x1), fill: nil, lines: []) }
                if !t.isEmpty { imageText.append(t.replacingOccurrences(of: "\n", with: " ")) }
            }
        }
        var text: String
        if kind == "text" { text = texts.joined(separator: "\n") }
        else if kind == "image" { text = imageText.isEmpty ? "[图片]" : "[图片] " + imageText.joined(separator: " ") }
        else { kind = "text"; text = "" }
        text = ([text] + quotes).filter { !$0.isEmpty }.joined(separator: "\n")
        let last = d.parts.last!.0
        let partial = d.partial || last.bottom >= areaBottom - 1
        messages.append(Message(side: d.side, sender: d.sender, text: text, kind: kind, top: Double(d.top), bottom: Double(d.bottom), partial: partial,
                                box: box.map { Box(x: Double($0.x0), y: Double($0.top), w: Double($0.x1 - $0.x0 + 1), h: Double($0.bottom - $0.top)) }))
    }
    messages.sort { $0.top < $1.top }
    if !isGroup && senderCount >= 1 && titleLine == nil { isGroup = true }
    let compact = messages

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
struct CropResult: Encodable { var ok: Bool; var error: String?; var width: Int; var height: Int; var bytes: Int; var std: Double = 0; var flat: Double = 0 }

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
    let st = lumaStats(scaled)
    return CropResult(ok: true, error: nil, width: w, height: h, bytes: data.count, std: st.std, flat: st.flat)
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
