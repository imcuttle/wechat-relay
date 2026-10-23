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
struct Message: Codable {
    var side: String          // self | other | system
    var sender: String?
    var text: String
    var kind: String          // text | media | time | system
    var top: Double; var bottom: Double
    var partial: Bool
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
        let probeXs = [Int(sl.x) - pt(120), chatLeft + pt(40), chatLeft + (chatRight - chatLeft) / 2]
        var tops: [Int] = []
        for px in probeXs where px > chatLeft {
            let y0 = Int(sl.y) - pt(70)
            let ref = bmp.px(px, y0)
            var y = y0
            while y > Int(Double(H) * 0.4) {
                if bmp.px(px, y).dist(ref) > 6 && bmp.px(px, y - 1).dist(ref) > 6 { break }
                y -= 1
            }
            tops.append(y)
        }
        tops.sort()
        if !tops.isEmpty { inputTop = tops[tops.count / 2] }
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

    // Lines not belonging to any avatar's block that are centred → time / system notices.
    for (i, a) in avs.enumerated() {
        let nextTop = i + 1 < avs.count ? Double(avs[i + 1].top) - 2 : Double(areaBottom)
        let top = Double(a.top) - Double(pt(4))
        var texts: [String] = []
        var sender: String? = nil
        var blockBottom = Double(a.bottom)
        for (li, l) in msgLines.enumerated() where !used.contains(li) && l.midY >= top && l.midY < nextTop {
            let isSelfSide = l.midX > chatMid || (a.side == "self" && l.maxX > chatMid)
            if (a.side == "self") != isSelfSide && abs(l.midX - chatMid) > chatW * 0.08 { continue }
            let centred = abs(l.midX - chatMid) < chatW * 0.12 && bubbleColor(l) == nil
            if centred && !(a.side == "other" && l.x < chatMid - chatW * 0.2) { continue }
            let bc = bubbleColor(l)
            if bc == nil && a.side == "other" && texts.isEmpty && sender == nil && l.midY < Double(a.top) + Double(pt(20)) {
                sender = l.text; used.insert(li); continue
            }
            if bc == nil && isTimeLike(l.text) { continue }
            texts.append(l.text); used.insert(li); blockBottom = max(blockBottom, l.maxY)
        }
        if a.side == "other" && sender != nil { isGroup = true }
        let partial = a.top <= areaTop + 1
        messages.append(Message(side: a.side, sender: sender, text: texts.isEmpty ? "[非文本消息]" : texts.joined(separator: "\n"),
                                kind: texts.isEmpty ? "media" : "text", top: Double(a.top), bottom: blockBottom, partial: partial))
    }
    // Orphan lines: time stamps / system notices / text of a message whose avatar is scrolled off.
    for (li, l) in msgLines.enumerated() where !used.contains(li) {
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

// MARK: - Entry

let enc = JSONEncoder()
func emit<T: Encodable>(_ v: T) {
    if let d = try? enc.encode(v), let s = String(data: d, encoding: .utf8) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
}

struct Req: Decodable { var id: Int; var image: String; var scale: Double? }
struct Resp: Encodable { var id: Int; var result: Result }

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "--serve" {
    setvbuf(stdout, nil, _IONBF, 0)
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let req = try? JSONDecoder().decode(Req.self, from: data) else { continue }
        autoreleasepool { emit(Resp(id: req.id, result: analyze(path: req.image, scaleHint: req.scale))) }
    }
} else if args.count >= 2 {
    emit(analyze(path: args[1], scaleHint: args.count >= 3 ? Double(args[2]) : nil))
} else {
    FileHandle.standardError.write("usage: wx-vision <image> [scale] | --serve\n".data(using: .utf8)!)
    exit(2)
}
