#!/usr/bin/env python3
"""Render the original README animation and GitHub preview artwork."""

from __future__ import annotations

from pathlib import Path
from tempfile import NamedTemporaryFile

import PIL
from PIL import Image, ImageDraw


EXPECTED_PILLOW = "12.3.0"
ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / ".github" / "assets"

GIF_SIZE = (960, 480)
SOCIAL_SIZE = (1280, 640)
FRAME_COUNT = 40
FRAME_DURATION_MS = 90

BG = (7, 13, 24)
SURFACE = (12, 22, 38)
SURFACE_RAISED = (16, 30, 49)
GRID = (27, 47, 69)
GRID_BRIGHT = (42, 67, 91)
MUTED = (105, 128, 148)
SOFT = (153, 173, 190)
WHITE = (232, 240, 246)
CYAN = (66, 202, 222)
BLUE = (79, 128, 244)
VIOLET = (145, 111, 246)
GREEN = (64, 204, 151)
AMBER = (245, 184, 80)
GREEN_DARK = (20, 74, 62)
BLUE_DARK = (25, 52, 92)
CYAN_DARK = (20, 63, 76)

PALETTE = (
    BG,
    SURFACE,
    SURFACE_RAISED,
    GRID,
    GRID_BRIGHT,
    MUTED,
    SOFT,
    WHITE,
    CYAN,
    BLUE,
    VIOLET,
    GREEN,
    AMBER,
    GREEN_DARK,
    BLUE_DARK,
    CYAN_DARK,
)

# A compact original 5x7 alphabet keeps rendering identical on every OS.
GLYPHS = {
    " ": (".....",) * 7,
    "A": (".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
    "B": ("####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."),
    "C": (".####", "#....", "#....", "#....", "#....", "#....", ".####"),
    "D": ("####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."),
    "E": ("#####", "#....", "#....", "####.", "#....", "#....", "#####"),
    "F": ("#####", "#....", "#....", "####.", "#....", "#....", "#...."),
    "G": (".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."),
    "H": ("#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
    "I": ("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"),
    "J": ("..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."),
    "K": ("#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"),
    "L": ("#....", "#....", "#....", "#....", "#....", "#....", "#####"),
    "M": ("#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"),
    "N": ("#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"),
    "O": (".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
    "P": ("####.", "#...#", "#...#", "####.", "#....", "#....", "#...."),
    "Q": (".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"),
    "R": ("####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"),
    "S": (".####", "#....", "#....", ".###.", "....#", "....#", "####."),
    "T": ("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."),
    "U": ("#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
    "V": ("#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."),
    "W": ("#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"),
    "X": ("#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"),
    "Y": ("#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."),
    "Z": ("#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"),
    "0": (".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."),
    "1": ("..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."),
    "2": (".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"),
    "3": ("####.", "....#", "....#", ".###.", "....#", "....#", "####."),
    "4": ("...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."),
    "5": ("#####", "#....", "#....", "####.", "....#", "....#", "####."),
    "6": (".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."),
    "7": ("#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."),
    "8": (".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."),
    "9": (".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."),
    "+": (".....", "..#..", "..#..", ".###.", "..#..", "..#..", "....."),
    "-": (".....", ".....", ".....", ".###.", ".....", ".....", "....."),
    "/": ("....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."),
    ".": (".....", ".....", ".....", ".....", ".....", ".##..", ".##.."),
    ":": (".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."),
}


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def smooth(value: float) -> float:
    value = clamp(value)
    return value * value * (3.0 - 2.0 * value)


class Scene:
    def __init__(self, size: tuple[int, int]) -> None:
        self.size = size
        self.scale = size[0] / GIF_SIZE[0]
        self.image = Image.new("RGB", size, BG)
        self.draw = ImageDraw.Draw(self.image)

    def c(self, value: float) -> int:
        return round(value * self.scale)

    def point(self, x: float, y: float) -> tuple[int, int]:
        return self.c(x), self.c(y)

    def box(self, values: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
        return tuple(self.c(value) for value in values)  # type: ignore[return-value]

    def rounded_box(
        self,
        values: tuple[float, float, float, float],
        radius: float,
        fill: tuple[int, int, int],
        outline: tuple[int, int, int] | None = None,
        width: int = 1,
    ) -> None:
        self.draw.rounded_rectangle(
            self.box(values),
            radius=self.c(radius),
            fill=fill,
            outline=outline,
            width=max(1, self.c(width)),
        )

    def line(
        self,
        points: list[tuple[float, float]],
        fill: tuple[int, int, int],
        width: int = 1,
    ) -> None:
        self.draw.line(
            [self.point(x, y) for x, y in points],
            fill=fill,
            width=max(1, self.c(width)),
            joint="curve",
        )

    def ellipse(
        self,
        values: tuple[float, float, float, float],
        fill: tuple[int, int, int],
        outline: tuple[int, int, int] | None = None,
        width: int = 1,
    ) -> None:
        self.draw.ellipse(
            self.box(values),
            fill=fill,
            outline=outline,
            width=max(1, self.c(width)),
        )

    def polygon(self, points: list[tuple[float, float]], fill: tuple[int, int, int]) -> None:
        self.draw.polygon([self.point(x, y) for x, y in points], fill=fill)

    def text(
        self,
        x: float,
        y: float,
        value: str,
        fill: tuple[int, int, int],
        cells: int = 2,
        align: str = "left",
    ) -> None:
        value = value.upper()
        cell = max(1, round(cells * self.scale))
        width = max(0, (len(value) * 6 - 1) * cell)
        left = self.c(x)
        if align == "center":
            left -= width // 2
        elif align == "right":
            left -= width
        top = self.c(y)
        for index, character in enumerate(value):
            glyph = GLYPHS.get(character, GLYPHS[" "])
            offset = left + index * 6 * cell
            for row, pattern in enumerate(glyph):
                for column, bit in enumerate(pattern):
                    if bit == "#":
                        x0 = offset + column * cell
                        y0 = top + row * cell
                        self.draw.rectangle((x0, y0, x0 + cell - 1, y0 + cell - 1), fill=fill)


def stage_color(progress: float, start: float, end: float) -> tuple[int, int, int]:
    if progress >= end:
        return GREEN
    if progress >= start:
        return CYAN
    return GRID_BRIGHT


def connector(scene: Scene, x1: float, x2: float, progress: float, start: float) -> None:
    active = progress >= start
    color = GREEN if progress >= start + 0.06 else (CYAN if active else GRID)
    scene.line([(x1, 236), (x2, 236)], color, 2)
    scene.polygon([(x2, 236), (x2 - 6, 232), (x2 - 6, 240)], color)


def card_shell(
    scene: Scene,
    bounds: tuple[float, float, float, float],
    title: str,
    color: tuple[int, int, int],
) -> None:
    scene.rounded_box(bounds, 12, SURFACE, GRID_BRIGHT, 1)
    x1, y1, x2, _ = bounds
    scene.text((x1 + x2) / 2, y1 + 15, title, color, 2, "center")
    scene.line([(x1 + 14, y1 + 41), (x2 - 14, y1 + 41)], GRID, 1)


def render_scene(
    size: tuple[int, int],
    progress: float,
    frame_index: int,
    *,
    social: bool = False,
) -> Image.Image:
    progress = clamp(progress)
    scene = Scene(size)

    # Quiet structural grid and moving scan line.
    for x in range(0, 961, 32):
        scene.line([(x, 112), (x, 448)], GRID if x % 64 else SURFACE_RAISED, 1)
    for y in range(128, 449, 32):
        scene.line([(0, y), (960, y)], GRID if y % 64 else SURFACE_RAISED, 1)
    scan_x = (frame_index * 29) % 960
    scene.line([(scan_x, 112), (scan_x, 448)], CYAN_DARK, 1)

    scene.text(36, 26, "UNFINISHED BUSINESS", WHITE, 3)
    scene.text(37, 62, "DURABLE AGENT ORCHESTRATION", SOFT, 2)
    scene.rounded_box((680, 24, 924, 82), 10, SURFACE, GRID_BRIGHT, 1)
    scene.text(802, 37, "BOUNDED WAVES", MUTED, 1, "center")
    scene.text(802, 56, "2 + 2 + 1", CYAN, 2, "center")
    scene.line([(0, 104), (960, 104)], GRID_BRIGHT, 1)

    capture_color = stage_color(progress, 0.00, 0.15)
    plan_color = stage_color(progress, 0.15, 0.55)
    schedule_color = stage_color(progress, 0.55, 0.69)
    execute_color = stage_color(progress, 0.69, 0.84)
    verify_color = stage_color(progress, 0.84, 1.00)

    card_shell(scene, (26, 156, 158, 318), "CAPTURE", capture_color)
    card_shell(scene, (184, 132, 416, 342), "PLAN", plan_color)
    card_shell(scene, (442, 156, 578, 318), "SCHEDULE", schedule_color)
    card_shell(scene, (604, 156, 758, 318), "EXECUTE", execute_color)
    card_shell(scene, (784, 156, 934, 318), "VERIFY", verify_color)

    connector(scene, 159, 179, progress, 0.12)
    connector(scene, 417, 437, progress, 0.52)
    connector(scene, 579, 599, progress, 0.66)
    connector(scene, 759, 779, progress, 0.81)

    # Capture: three durable queue cards with a traveling work item.
    capture_phase = smooth(progress / 0.15)
    for offset in (12, 6, 0):
        x1 = 57 + offset
        y1 = 215 - offset
        scene.rounded_box((x1, y1, x1 + 68, y1 + 49), 5, SURFACE_RAISED, GRID_BRIGHT, 1)
    scene.line([(73, 228), (105, 228)], capture_color, 3)
    scene.line([(73, 239), (113, 239)], GRID_BRIGHT, 2)
    scene.line([(73, 250), (96, 250)], GRID_BRIGHT, 2)
    item_x = 45 + 92 * capture_phase
    scene.ellipse((item_x - 4, 282, item_x + 4, 290), CYAN if progress < 0.15 else GREEN)
    scene.text(92, 294, "QUEUE", MUTED, 1, "center")

    # Plan: five agents, admitted in bounded waves of two, two, then one.
    wave_thresholds = (0.18, 0.18, 0.31, 0.31, 0.44)
    agent_positions = ((267, 213), (343, 213), (267, 258), (343, 258), (305, 303))
    scene.line([(267, 213), (305, 303), (343, 213)], GRID, 1)
    scene.line([(267, 258), (343, 258)], GRID, 1)
    for label, y in (("W1", 208), ("W2", 253), ("W3", 298)):
        scene.text(207, y, label, MUTED, 1)
    for index, ((x, y), threshold) in enumerate(zip(agent_positions, wave_thresholds)):
        if progress >= threshold + 0.09:
            fill, outline = GREEN_DARK, GREEN
        elif progress >= threshold:
            pulse = (frame_index + index) % 4 < 2
            fill, outline = (BLUE_DARK, CYAN) if pulse else (CYAN_DARK, BLUE)
        else:
            fill, outline = SURFACE_RAISED, GRID_BRIGHT
        scene.ellipse((x - 14, y - 14, x + 14, y + 14), fill, outline, 2)
        scene.ellipse((x - 4, y - 4, x + 4, y + 4), outline)
    scene.text(390, 202, "2", MUTED, 1, "right")
    scene.text(390, 247, "2", MUTED, 1, "right")
    scene.text(390, 292, "1", MUTED, 1, "right")
    scene.text(300, 324, "FIVE AGENTS", plan_color, 1, "center")

    # Schedule: bounded rows advance into durable slots.
    schedule_phase = smooth((progress - 0.55) / 0.14)
    grid_left, grid_top = 465, 213
    for row in range(3):
        for column in range(3):
            x1 = grid_left + column * 31
            y1 = grid_top + row * 24
            slot_index = row * 3 + column
            reached = schedule_phase * 9 > slot_index
            slot_fill = BLUE_DARK if reached else SURFACE_RAISED
            slot_outline = CYAN if reached else GRID_BRIGHT
            scene.rounded_box((x1, y1, x1 + 23, y1 + 15), 3, slot_fill, slot_outline, 1)
    scene.text(510, 294, "3 WAVES", schedule_color, 1, "center")

    # Execute: terminal strokes arrive one by one.
    execute_phase = smooth((progress - 0.69) / 0.15)
    scene.rounded_box((626, 207, 736, 279), 6, BG, GRID_BRIGHT, 1)
    scene.ellipse((638, 218, 643, 223), AMBER)
    scene.ellipse((648, 218, 653, 223), CYAN)
    scene.ellipse((658, 218, 663, 223), GREEN)
    line_lengths = (62, 45, 70)
    for row, length in enumerate(line_lengths):
        shown = clamp(execute_phase * 3 - row)
        color = GREEN if shown >= 1 else (CYAN if shown > 0 else GRID)
        scene.line([(640, 239 + row * 13), (640 + length * shown, 239 + row * 13)], color, 3)
    cursor_on = frame_index % 4 < 2 and 0.69 <= progress < 0.84
    scene.line([(715, 266), (725, 266)], CYAN if cursor_on else GRID_BRIGHT, 3)
    scene.text(681, 294, "RUN", execute_color, 1, "center")

    # Verify: the check draws only after all bounded work has executed.
    verify_phase = smooth((progress - 0.84) / 0.16)
    scene.ellipse((823, 202, 895, 274), GREEN_DARK if verify_phase >= 1 else SURFACE_RAISED, verify_color, 3)
    if verify_phase > 0:
        first = clamp(verify_phase / 0.45)
        second = clamp((verify_phase - 0.35) / 0.65)
        a = (840, 239)
        b = (855, 253)
        c = (881, 220)
        mid = (a[0] + (b[0] - a[0]) * first, a[1] + (b[1] - a[1]) * first)
        scene.line([a, mid], GREEN, 5)
        if second > 0:
            end = (b[0] + (c[0] - b[0]) * second, b[1] + (c[1] - b[1]) * second)
            scene.line([b, end], GREEN, 5)
    scene.text(859, 294, "PROOF", verify_color, 1, "center")

    # A single work token traces the complete lifecycle.
    centers = (92, 300, 510, 681, 859)
    route_progress = smooth(progress)
    segment_float = route_progress * 4
    segment = min(3, int(segment_float))
    local = segment_float - segment
    token_x = centers[segment] + (centers[segment + 1] - centers[segment]) * local
    scene.line([(centers[0], 375), (centers[-1], 375)], GRID_BRIGHT, 2)
    for index, x in enumerate(centers):
        reached = route_progress * 4 >= index
        scene.ellipse((x - 6, 369, x + 6, 381), GREEN if reached else SURFACE_RAISED, GREEN if reached else GRID_BRIGHT, 1)
    scene.ellipse((token_x - 5, 370, token_x + 5, 380), CYAN, WHITE, 1)

    status_ranges = (
        (0.15, "CAPTURING"),
        (0.31, "PLANNING WAVE 1"),
        (0.44, "PLANNING WAVE 2"),
        (0.55, "PLANNING WAVE 3"),
        (0.69, "SCHEDULING"),
        (0.84, "EXECUTING"),
        (1.00, "VERIFYING"),
        (1.01, "VERIFIED"),
    )
    status = next(label for ceiling, label in status_ranges if progress < ceiling)
    scene.rounded_box((36, 405, 268, 439), 17, SURFACE, GRID_BRIGHT, 1)
    scene.ellipse((51, 418, 59, 426), GREEN if progress >= 1 else CYAN)
    scene.text(72, 416, status, WHITE, 1)
    scene.text(924, 416, "LOCAL FIRST / HUMAN GATED / VERIFIABLE", MUTED, 1, "right")

    if social:
        # The social card uses the same visual language with a strong safe-area frame.
        scene.draw.rounded_rectangle(
            scene.box((10, 10, 950, 470)),
            radius=scene.c(14),
            outline=GRID_BRIGHT,
            width=max(1, scene.c(1)),
        )

    return scene.image


def fixed_palette() -> Image.Image:
    palette_image = Image.new("P", (1, 1))
    values = [component for color in PALETTE for component in color]
    values.extend([0] * (768 - len(values)))
    palette_image.putpalette(values)
    return palette_image


def palettize(image: Image.Image, palette_image: Image.Image) -> Image.Image:
    return image.quantize(palette=palette_image, dither=Image.Dither.NONE)


def same_png(existing: Path, candidate: Path) -> bool:
    if not existing.exists():
        return False
    with Image.open(existing) as left, Image.open(candidate) as right:
        return left.mode == right.mode and left.size == right.size and left.tobytes() == right.tobytes()


def same_gif(existing: Path, candidate: Path) -> bool:
    if not existing.exists():
        return False
    with Image.open(existing) as left, Image.open(candidate) as right:
        if left.size != right.size or left.n_frames != right.n_frames:
            return False
        if left.info.get("loop") != right.info.get("loop"):
            return False
        for index in range(left.n_frames):
            left.seek(index)
            right.seek(index)
            if left.info.get("duration") != right.info.get("duration"):
                return False
            if left.convert("RGB").tobytes() != right.convert("RGB").tobytes():
                return False
    return True


def write_png(path: Path, image: Image.Image) -> None:
    with NamedTemporaryFile(dir=path.parent, suffix=".png", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        image.save(temporary, format="PNG", optimize=True, compress_level=9)
        if not same_png(path, temporary):
            temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def write_gif(path: Path, frames: list[Image.Image]) -> None:
    with NamedTemporaryFile(dir=path.parent, suffix=".gif", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        frames[0].save(
            temporary,
            format="GIF",
            save_all=True,
            append_images=frames[1:],
            duration=FRAME_DURATION_MS,
            disposal=1,
            optimize=True,
        )
        if not same_gif(path, temporary):
            temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_assets() -> None:
    gif_path = ASSETS / "agent-orchestration.gif"
    poster_path = ASSETS / "agent-orchestration-poster.png"
    social_path = ASSETS / "social-preview.png"
    with Image.open(gif_path) as animation:
        assert animation.size == GIF_SIZE
        assert animation.n_frames == FRAME_COUNT
        assert animation.info.get("loop") is None, "GIF must play once, not loop"
        duration = 0
        for index in range(animation.n_frames):
            animation.seek(index)
            duration += int(animation.info.get("duration", 0))
        assert duration <= 5000
    with Image.open(poster_path) as poster:
        assert poster.size == GIF_SIZE
    with Image.open(social_path) as social:
        assert social.size == SOCIAL_SIZE
    assert gif_path.stat().st_size < 1_000_000
    assert poster_path.stat().st_size < 500_000
    assert social_path.stat().st_size < 1_000_000


def main() -> None:
    if PIL.__version__ != EXPECTED_PILLOW:
        raise SystemExit(f"Pillow {EXPECTED_PILLOW} is required; found {PIL.__version__}")
    ASSETS.mkdir(parents=True, exist_ok=True)
    palette_image = fixed_palette()
    frames = [
        palettize(
            render_scene(GIF_SIZE, index / (FRAME_COUNT - 1), index),
            palette_image,
        )
        for index in range(FRAME_COUNT)
    ]
    write_gif(ASSETS / "agent-orchestration.gif", frames)
    write_png(
        ASSETS / "agent-orchestration-poster.png",
        render_scene(GIF_SIZE, 1.0, FRAME_COUNT - 1),
    )
    write_png(
        ASSETS / "social-preview.png",
        render_scene(SOCIAL_SIZE, 1.0, FRAME_COUNT - 1, social=True),
    )
    validate_assets()
    for name in ("agent-orchestration.gif", "agent-orchestration-poster.png", "social-preview.png"):
        path = ASSETS / name
        print(f"{name}: {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
