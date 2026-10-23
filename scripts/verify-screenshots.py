"""Audit the committed native-client mock screenshots without modifying them."""
from pathlib import Path
import hashlib
import json
import struct

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'docs/design/screenshot-assets.json').read_text('utf-8'))
assets = manifest['assets']
assert len(assets) == 6, 'Expected six native-client screenshots'
for asset in assets:
    filename = asset['file']
    assert Path(filename).name == filename, 'Asset names must be filenames only'
    payload = (root / 'docs/images' / filename).read_bytes()
    assert payload[:8] == b'\x89PNG\r\n\x1a\n', f'{filename}: invalid PNG'
    width, height = struct.unpack('>II', payload[16:24])
    assert [width, height] == asset['dimensions'], f'{filename}: dimensions changed'
    assert width >= 1400 and height >= 850, f'{filename}: resolution too low'
    assert hashlib.sha256(payload).hexdigest() == asset['sha256'], f'{filename}: asset changed without a manifest update'
    print(f'{filename}: PASS ({width} x {height})')
print('Six English native-client mock screenshots verified. No files modified.')
