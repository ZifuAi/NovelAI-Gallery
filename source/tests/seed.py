import struct, zlib, json, sys, os

def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)

def png(path, w, h, rgb, texts):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    for k, v in texts.items():
        out += chunk(b'tEXt', k.encode() + b'\x00' + v.encode('latin-1', 'replace'))
    out += chunk(b'IDAT', zlib.compress(raw))
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)

comment = lambda p, uc: json.dumps({"prompt": p, "uc": uc, "steps": 28, "scale": 5.0,
                                    "sampler": "k_euler_ancestral", "seed": 12345})
specs = [
    ("safe-portrait.png",  700, 1000, (120,150,220), "1girl, long hair, school uniform, standing, detailed background", "worst quality, blurry"),
    ("safe-landscape.png", 1200, 700, (110,190,140), "scenic landscape, mountains, sunset, no humans", "low quality"),
    ("explicit.png",       800,  800, (200,120,130), "1girl, nude, spread pussy, explicit, nsfw", "bad anatomy"),
    ("anatomy-only.png",   760,  980, (180,160,200), "1girl, large breasts, swimsuit, beach", "worst quality"),
    ("wide.png",          1600,  600, (150,150,150), "cityscape, night, neon lights", "blurry"),
    ("tall.png",           600, 1500, (170,140,110), "tower, clouds, wide shot", "low quality"),
]
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
for name, w, h, rgb, p, uc in specs:
    png(os.path.join(out, name), w, h, rgb,
        {"Software": "NovelAI", "Description": p, "Comment": comment(p, uc)})
