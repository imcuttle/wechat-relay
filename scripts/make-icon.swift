// Renders build/icon.png (1024x1024): green macOS-style squircle with white chat bubbles and a relay bolt.
// Usage: swift scripts/make-icon.swift build/icon.png
import AppKit

let out = CommandLine.arguments[1]
let S: CGFloat = 1024
// Draw into an exact 1024x1024 bitmap (lockFocus would render at the screen's Retina scale).
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(S), pixelsHigh: Int(S), bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext

// Squircle body (Apple grid: 824pt body inside 1024 canvas) with drop shadow.
let body = NSRect(x: 100, y: 100, width: 824, height: 824)
let path = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 30, color: NSColor.black.withAlphaComponent(0.25).cgColor)
NSColor(calibratedRed: 0.03, green: 0.76, blue: 0.38, alpha: 1).setFill()
path.fill()
ctx.restoreGState()
NSGradient(colors: [NSColor(calibratedRed: 0.20, green: 0.86, blue: 0.50, alpha: 1),
                    NSColor(calibratedRed: 0.02, green: 0.66, blue: 0.33, alpha: 1)])!.draw(in: path, angle: -90)

func symbol(_ name: String, _ pt: CGFloat, _ rect: NSRect, _ color: NSColor) {
    let cfg = NSImage.SymbolConfiguration(pointSize: pt, weight: .semibold).applying(.init(paletteColors: [color]))
    guard let sym = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg) else { return }
    let s = sym.size, k = min(rect.width / s.width, rect.height / s.height)
    let r = NSRect(x: rect.midX - s.width * k / 2, y: rect.midY - s.height * k / 2, width: s.width * k, height: s.height * k)
    sym.draw(in: r)
}
symbol("bubble.left.and.bubble.right.fill", 400, NSRect(x: 210, y: 250, width: 604, height: 520), .white)
// Small badge: bolt = automatic reply.
let badge = NSRect(x: 650, y: 160, width: 230, height: 230)
NSColor(calibratedRed: 0.02, green: 0.62, blue: 0.31, alpha: 1).setFill(); NSBezierPath(ovalIn: badge.insetBy(dx: -22, dy: -22)).fill()
NSColor.white.setFill(); NSBezierPath(ovalIn: badge).fill()
symbol("bolt.fill", 140, badge.insetBy(dx: 55, dy: 45), NSColor(calibratedRed: 0.02, green: 0.66, blue: 0.33, alpha: 1))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
