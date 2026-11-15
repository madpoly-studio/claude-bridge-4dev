"""Sinh sprite sheet hoạt ảnh cho robot worker từ ảnh tĩnh 1024x1024.

Chạy:  uv run --with pillow python brainstorm/newUI/tools/gen_worker_sheets.py

Cách làm: tách mỗi robot thành 2 lớp (đầu / thân) theo một đường cắt ngang ở cổ, rồi dựng frame bằng
dịch chuyển + xoay đầu, nhún / nghiêng / co giãn toàn thân và hiệu ứng màu. Không vẽ thêm pixel nào,
nên mọi frame giữ đúng nét của ảnh gốc.

Kết quả (sprites/robot_workers_animated/):
  workerN_sheet.png   mỗi hàng một animation, mỗi cột một frame, ô CELL x CELL
  manifest.json       kích thước ô, điểm neo, fps, vị trí từng frame
  preview.html        mở bằng trình duyệt để xem animation chạy
"""
import json
from pathlib import Path

from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parent.parent / "sprites"
SRC_DIR = ROOT / "robot_workers_transparent_pngs"
OUT_DIR = ROOT / "robot_workers_animated"

SRC = 1024          # cạnh ảnh gốc
CELL = 256          # cạnh một ô trong sheet
BASELINE = 937      # y của mặt đất (đáy bánh xích) trong ảnh gốc
CENTER_X = 512
OVERLAP = 22        # phần cổ lớp thân giữ lại phía trên đường cắt, để đầu nhấc lên không hở
NECK_HALF_WIDTH = 70

# worker -> (y đường cắt ở cổ, x tâm cổ = tâm xoay của đầu), đo trên ảnh gốc
WORKERS = {
    "worker1": (390, 517),
    "worker2": (432, 480),
    "worker3": (388, 486),
    "worker4": (468, 538),
    "worker5": (422, 520),
}


def frames(n, **cols):
    """Mỗi tham số là một giá trị chung hoặc danh sách n giá trị theo frame."""
    out = []
    for i in range(n):
        out.append({k: (v[i] if isinstance(v, (list, tuple)) else v) for k, v in cols.items()})
    return out


# Mỗi frame: head_dy / head_rot (đầu), dx / dy / rot (toàn thân), sy (co giãn dọc, neo ở mặt đất),
# tint (0..1 ánh đỏ), sleep (làm tối + giảm bão hòa). Đơn vị px theo ảnh gốc; góc theo độ, dương = ngược chiều kim.
ANIMS = {
    # đứng yên, đầu nhấp nhô nhẹ
    "idle": dict(fps=6, loop=True, frames=frames(
        6, head_dy=[0, -3, -6, -8, -6, -3], sy=[1, 1.004, 1.008, 1.01, 1.008, 1.004])),
    # đang làm việc: gật đầu nhìn màn hình, thân rung theo nhịp gõ
    "work": dict(fps=8, loop=True, frames=frames(
        6, head_rot=[0, -2, -4, -2, 0, 1.5], head_dy=[0, 2, 4, 2, 0, -2], dy=[0, -3, 0, -3, 0, -3])),
    # di chuyển: nghiêng về trước, nảy theo bánh xích
    "move": dict(fps=8, loop=True, frames=frames(
        4, rot=-3, dy=[0, -8, 0, -8], head_dy=[-5, 2, -5, 2])),
    # lỗi: lắc ngang, chớp đỏ
    "error": dict(fps=10, loop=True, frames=frames(
        4, dx=[-12, 12, -8, 8], head_rot=[3, -3, 2, -2], tint=[0.35, 0, 0.35, 0])),
    # offline: gục đầu, tối màu, thở chậm
    "sleep": dict(fps=2, loop=True, frames=frames(
        4, head_dy=[14, 16, 18, 16], head_rot=-9, sleep=True)),
    # xong task: nhảy lên
    "happy": dict(fps=10, loop=False, frames=frames(
        6, sy=[0.93, 1.05, 1.02, 1.0, 0.94, 1.0], dy=[0, -30, -46, -28, 0, 0], head_dy=[6, -8, -10, -4, 8, 0])),
}
COLS = max(len(a["frames"]) for a in ANIMS.values())


def split_layers(src, cut_y, pivot_x):
    """Trả về (thân, đầu). Thân giữ thêm một dải cổ phía trên đường cắt để lấp khe khi đầu nhấc lên."""
    clear = Image.new("RGBA", (SRC, SRC), (0, 0, 0, 0))
    head = src.copy()
    head.paste(clear.crop((0, cut_y, SRC, SRC)), (0, cut_y))
    body = clear.copy()
    body.paste(src.crop((0, cut_y, SRC, SRC)), (0, cut_y))
    neck_box = (pivot_x - NECK_HALF_WIDTH, cut_y - OVERLAP, pivot_x + NECK_HALF_WIDTH, cut_y)
    body.paste(src.crop(neck_box), neck_box[:2])
    return body, head


def rotate(img, angle, center, translate=(0, 0)):
    """Xoay / dịch trên alpha nhân sẵn để viền không bị tối."""
    if not angle and translate == (0, 0):
        return img
    pre = img.convert("RGBa").rotate(angle, resample=Image.BICUBIC, center=center, translate=translate)
    return pre.convert("RGBA")


def squash(img, sy):
    """Co giãn theo chiều dọc, giữ nguyên vị trí mặt đất."""
    if sy == 1:
        return img
    new_h = round(BASELINE * sy)
    top = img.crop((0, 0, SRC, BASELINE)).convert("RGBa").resize((SRC, new_h), Image.BICUBIC).convert("RGBA")
    out = Image.new("RGBA", (SRC, SRC), (0, 0, 0, 0))
    out.paste(img.crop((0, BASELINE, SRC, SRC)), (0, BASELINE))
    if new_h > BASELINE:  # phần vượt mép trên là vùng trong suốt, cắt bỏ
        top = top.crop((0, new_h - BASELINE, SRC, new_h))
        new_h = BASELINE
    out.alpha_composite(top, (0, BASELINE - new_h))
    return out


def recolor(img, tint=0.0, sleep=False):
    if not tint and not sleep:
        return img
    alpha = img.getchannel("A")
    rgb = img.convert("RGB")
    if sleep:
        rgb = ImageEnhance.Color(rgb).enhance(0.35)
        rgb = ImageEnhance.Brightness(rgb).enhance(0.72)
        rgb = Image.blend(rgb, Image.new("RGB", rgb.size, (60, 70, 110)), 0.18)
    if tint:
        rgb = Image.blend(rgb, Image.new("RGB", rgb.size, (255, 60, 50)), tint)
    rgb.putalpha(alpha)
    return rgb


def render(body, head, cut_y, pivot_x, f, cell=CELL):
    moved_head = rotate(head, f.get("head_rot", 0), (pivot_x, cut_y), (0, f.get("head_dy", 0)))
    frame = body.copy()
    frame.alpha_composite(moved_head)
    frame = squash(frame, f.get("sy", 1))
    frame = rotate(frame, f.get("rot", 0), (CENTER_X, BASELINE), (f.get("dx", 0), f.get("dy", 0)))
    frame = recolor(frame, f.get("tint", 0.0), f.get("sleep", False))
    return frame.convert("RGBa").resize((cell, cell), Image.LANCZOS).convert("RGBA")


def build_sheet(worker, cell=CELL):
    """Dựng sheet của một worker với cạnh ô tùy chọn (build_office_assets.py dùng ô nhỏ hơn cho web)."""
    cut_y, pivot_x = WORKERS[worker]
    src = Image.open(SRC_DIR / f"{worker}.png").convert("RGBA")
    body, head = split_layers(src, cut_y, pivot_x)
    sheet = Image.new("RGBA", (COLS * cell, len(ANIMS) * cell), (0, 0, 0, 0))
    for row, anim in enumerate(ANIMS.values()):
        for col, f in enumerate(anim["frames"]):
            sheet.paste(render(body, head, cut_y, pivot_x, f, cell), (col * cell, row * cell))
    return sheet


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    scale = CELL / SRC
    manifest = {
        "cell_size": [CELL, CELL],
        "columns": COLS,
        "anchor": [round(CENTER_X * scale), round(BASELINE * scale)],
        "anchor_note": "điểm chạm đất (giữa đáy bánh xích) trong mỗi ô; đặt điểm này lên tọa độ sàn",
        "workers": {name: f"{name}_sheet.png" for name in WORKERS},
        "states": {},
    }
    for row, (name, anim) in enumerate(ANIMS.items()):
        manifest["states"][name] = {
            "fps": anim["fps"],
            "loop": anim["loop"],
            "row": row,
            "frames": [[col * CELL, row * CELL, CELL, CELL] for col in range(len(anim["frames"]))],
        }
    for worker in WORKERS:
        sheet = build_sheet(worker)
        sheet.save(OUT_DIR / f"{worker}_sheet.png", optimize=True)
        print(f"{worker}_sheet.png  {sheet.size[0]}x{sheet.size[1]}")
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT_DIR / "preview.html").write_text(PREVIEW.replace("__MANIFEST__", json.dumps(manifest)), encoding="utf-8")
    print("manifest.json, preview.html")


PREVIEW = """<!doctype html>
<meta charset="utf-8">
<title>Robot worker animations</title>
<style>
  body { margin: 0; padding: 24px; background: #c9a79b; font: 14px system-ui, sans-serif; color: #2b2233; }
  body.dark { background: #1d1a24; color: #e8e2f0; }
  table { border-collapse: collapse; }
  th, td { padding: 6px 10px; text-align: center; }
  .sprite { background-repeat: no-repeat; }
  label { margin-right: 16px; }
</style>
<p><label>Kích thước <select id="size"><option>96</option><option selected>128</option><option>256</option></select> px</label>
<label><input type="checkbox" id="dark"> nền tối</label></p>
<table id="grid"></table>
<script>
const M = __MANIFEST__;
const states = Object.keys(M.states), workers = Object.keys(M.workers);
document.getElementById('grid').innerHTML =
  '<tr><th></th>' + states.map(s => `<th>${s}<br><small>${M.states[s].fps} fps</small></th>`).join('') + '</tr>' +
  workers.map(w => `<tr><th>${w}</th>` +
    states.map(s => `<td><div class="sprite" data-w="${w}" data-s="${s}"></div></td>`).join('') + '</tr>').join('');
let size = 128;
function draw(t) {
  for (const el of document.querySelectorAll('.sprite')) {
    const st = M.states[el.dataset.s], n = st.frames.length;
    let i = Math.floor(t / 1000 * st.fps);
    // không lặp: phát một lượt, dừng ở frame cuối khoảng 1 giây rồi phát lại
    i = st.loop ? i % n : Math.min(i % (n + st.fps), n - 1);
    const k = size / M.cell_size[0], f = st.frames[i];
    el.style.width = el.style.height = size + 'px';
    el.style.backgroundImage = `url(${M.workers[el.dataset.w]})`;
    el.style.backgroundSize = `${M.columns * M.cell_size[0] * k}px auto`;
    el.style.backgroundPosition = `${-f[0] * k}px ${-f[1] * k}px`;
  }
  requestAnimationFrame(draw);
}
document.getElementById('size').onchange = e => { size = +e.target.value; };
document.getElementById('dark').onchange = e => document.body.classList.toggle('dark', e.target.checked);
requestAnimationFrame(draw);
</script>
"""

if __name__ == "__main__":
    main()
