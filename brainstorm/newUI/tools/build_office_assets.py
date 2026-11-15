"""Xuất asset của chế độ Virtual Office sang WebP cho packages/web.

Chạy:  uv run --with pillow python brainstorm/newUI/tools/build_office_assets.py

Đầu ra: packages/web/src/components/office/assets/
  background.webp          nền 1448x1086
  worker1..5.webp          sheet 6x6, ô WORKER_CELL px (dựng lại từ ảnh gốc 1024 px, không thu từ sheet 256)
  planner.webp, orchestrator.webp   cắt từ agents_portrait_atlas.png (bản nét nhất trong bộ asset)
  furniture/<tên>.webp     chỉ những món có trong FURNITURE

Script in bảng dung lượng và tổng; mục tiêu cả thư mục dưới 3 MB.
assets/index.ts viết tay, import các file này; thêm món mới thì thêm cả ở hai nơi.
"""
import sys
from pathlib import Path

from PIL import Image

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import gen_worker_sheets as gen  # noqa: E402

SPRITES = TOOLS.parent / "sprites"
PACK = SPRITES / "office_isometric_sprite_pack"
OUT = TOOLS.parents[2] / "packages" / "web" / "src" / "components" / "office" / "assets"

WORKER_CELL = 192
BUDGET_BYTES = 3 * 1024 * 1024

FURNITURE = [
    "workstation_basic", "workstation_dual", "workstation_analytics", "workstation_manager",
    "sofa", "vending_machine", "water_dispenser", "arcade_cabinet", "coffee_station",
    "bookshelf_lounge", "floor_lamp", "guitar", "recharge_pod", "server_rack", "utility_shelf",
    "kanban_board", "flow_board", "planning_table", "hologram_table", "dashboard_monitor",
    "potted_palm", "palm_planter", "flower_box", "small_planter", "flower_planter", "robot_vacuum",
]

# (tên file ra, hộp cắt trong agents_portrait_atlas.png 512x256)
AGENTS = {"planner": (0, 0, 256, 256), "orchestrator": (256, 0, 512, 256)}


def save(img, path, **opts):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "WEBP", method=6, **opts)
    return path.stat().st_size


def main():
    rows = []
    # Dọn file cũ để thư mục chỉ chứa đúng những gì script sinh ra (index.ts viết tay được giữ lại).
    for old in list(OUT.glob("*.webp")) + list((OUT / "furniture").glob("*.webp")):
        old.unlink()
    bg = Image.open(SPRITES / "Empty Isometric Sky-Office Interior.png").convert("RGB")
    rows.append(("background.webp", bg.size, save(bg, OUT / "background.webp", quality=84)))

    for i, worker in enumerate(gen.WORKERS, start=1):
        sheet = gen.build_sheet(worker, WORKER_CELL)
        rows.append((f"worker{i}.webp", sheet.size, save(sheet, OUT / f"worker{i}.webp", quality=86, alpha_quality=92)))

    atlas = Image.open(PACK / "agents" / "agents_portrait_atlas.png").convert("RGBA")
    for name, box in AGENTS.items():
        half = atlas.crop(box)
        cut = half.crop(half.getbbox())
        rows.append((f"{name}.webp", cut.size, save(cut, OUT / f"{name}.webp", lossless=True)))

    for name in FURNITURE:
        img = Image.open(PACK / "furniture" / f"{name}.png").convert("RGBA")
        rows.append((f"furniture/{name}.webp", img.size, save(img, OUT / "furniture" / f"{name}.webp", lossless=True)))

    total = sum(r[2] for r in rows)
    for name, size, nbytes in rows:
        print(f"{name:40s} {size[0]:>5}x{size[1]:<5} {nbytes / 1024:8.1f} KB")
    print(f"{'TỔNG':40s} {'':11s} {total / 1024:8.1f} KB  ({total / 1024 / 1024:.2f} MB, ngân sách 3 MB)")
    scale = WORKER_CELL / gen.SRC
    print(f"Ô worker {WORKER_CELL}px; điểm neo trong ô: [{gen.CENTER_X * scale:.1f}, {gen.BASELINE * scale:.1f}]"
          f" (tỉ lệ {gen.CENTER_X / gen.SRC:.4f}, {gen.BASELINE / gen.SRC:.4f} của cạnh ô)")
    if total > BUDGET_BYTES:
        sys.exit("Vượt ngân sách 3 MB")


if __name__ == "__main__":
    main()
