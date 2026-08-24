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
# One image written the way V4/V5 write a multi-character picture, so the
# round trip from gallery back into the generator can be tested for real.
def v4_comment(base, uc, chars):
    return json.dumps({
        "prompt": base, "uc": uc, "steps": 28, "scale": 5.0,
        "sampler": "k_euler_ancestral", "seed": 12345,
        "v4_prompt": {
            "caption": {
                "base_caption": base,
                "char_captions": [
                    {"char_caption": c[0], "centers": [{"x": c[2], "y": c[3]}]}
                    for c in chars
                ],
            },
            "use_coords": True,
            "use_order": True,
        },
        "v4_negative_prompt": {
            "caption": {
                "base_caption": uc,
                "char_captions": [{"char_caption": c[1], "centers": []} for c in chars],
            },
        },
    })

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

# A two-character image, positions and all.
png(os.path.join(out, "two-characters.png"), 832, 1216, (140, 170, 190), {
    "Software": "NovelAI",
    "Description": "2girls, park bench, afternoon",
    "Comment": v4_comment(
        "2girls, park bench, afternoon",
        "lowres, bad anatomy",
        [("1girl, red hair, sundress", "hat", 0.3, 0.5),
         ("1girl, blue hair, cardigan", "glasses", 0.7, 0.5)],
    ),
})
