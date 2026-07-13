from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math
import os

def create_icon(size=1024):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角背景
    radius = int(size * 0.1875)
    bg_gradient = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg_gradient)

    for y in range(size):
        r = int(26 + (45 - 26) * y / size)
        g = int(54 + (90 - 54) * y / size)
        b = int(93 + (135 - 93) * y / size)
        bg_draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    # 创建圆角遮罩
    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)

    bg_gradient.putalpha(mask)
    img.paste(bg_gradient, (0, 0), bg_gradient)

    draw = ImageDraw.Draw(img)

    # 远山
    mountain_color = (59, 89, 152, 100)
    points = []
    for i in range(20):
        x = i * size / 19
        base_y = size * 0.75
        height = size * 0.15 * (0.5 + 0.5 * math.sin(i * 0.8 + 1))
        points.append((x, base_y - height))
    points.append((size, size))
    points.append((0, size))
    draw.polygon(points, fill=mountain_color)

    # 中景山
    mountain_color2 = (74, 124, 89, 180)
    points2 = []
    for i in range(15):
        x = i * size / 14
        base_y = size * 0.82
        height = size * 0.18 * (0.4 + 0.6 * math.sin(i * 1.1 + 2))
        points2.append((x, base_y - height))
    points2.append((size, size))
    points2.append((0, size))
    draw.polygon(points2, fill=mountain_color2)

    # 主峰 - 高山
    main_mountain_color = (45, 90, 61, 230)
    main_peak_x = size * 0.62
    main_peak_y = size * 0.28
    left_base_x = size * 0.25
    right_base_x = size * 0.82
    base_y = size * 0.82

    # 左山脚小山峰
    left_peak_x = size * 0.43
    left_peak_y = size * 0.39

    # 右侧小山峰
    right_peak_x = size * 0.75
    right_peak_y = size * 0.5

    main_points = [
        (left_base_x, base_y),
        (left_peak_x, left_peak_y),
        (size * 0.5, size * 0.55),
        (main_peak_x, main_peak_y),
        (right_peak_x, right_peak_y),
        (right_base_x, base_y),
    ]
    draw.polygon(main_points, fill=main_mountain_color)

    # 山顶积雪
    snow_color = (255, 255, 255, 230)
    # 主峰雪
    snow_points_main = [
        (main_peak_x - size * 0.04, main_peak_y + size * 0.06),
        (main_peak_x, main_peak_y),
        (main_peak_x + size * 0.05, main_peak_y + size * 0.09),
        (main_peak_x + size * 0.02, main_peak_y + size * 0.05),
    ]
    draw.polygon(snow_points_main, fill=snow_color)

    # 左峰雪
    snow_points_left = [
        (left_peak_x - size * 0.03, left_peak_y + size * 0.05),
        (left_peak_x, left_peak_y),
        (left_peak_x + size * 0.025, left_peak_y + size * 0.04),
    ]
    draw.polygon(snow_points_left, fill=snow_color)

    # 太阳/明月
    sun_x = size * 0.74
    sun_y = size * 0.22
    sun_r = size * 0.07

    # 太阳光晕
    for i in range(20, 0, -1):
        alpha = int(15 * (1 - i / 20))
        glow_r = sun_r + i * size * 0.003
        draw.ellipse(
            [sun_x - glow_r, sun_y - glow_r, sun_x + glow_r, sun_y + glow_r],
            fill=(251, 191, 36, alpha)
        )

    draw.ellipse(
        [sun_x - sun_r, sun_y - sun_r, sun_x + sun_r, sun_y + sun_r],
        fill=(251, 191, 36, 230)
    )

    # 流水 - 瀑布
    water_x = size * 0.42
    water_start_y = size * 0.55
    water_end_y = size * 0.95
    water_width = size * 0.025

    # 瀑布主体（用波浪线模拟水流）
    for i in range(3):
        offset_x = i * size * 0.018
        points_water = []
        for y in range(int(water_start_y), int(water_end_y), 3):
            wave = math.sin((y - water_start_y) * 0.03 + i) * size * 0.012
            x = water_x + offset_x + wave
            points_water.append((x, y))

        # 绘制水流线
        for j in range(len(points_water) - 1):
            x1, y1 = points_water[j]
            x2, y2 = points_water[j + 1]
            alpha = int(180 * (1 - j / len(points_water) * 0.3))
            draw.line([(x1, y1), (x2, y2)], fill=(147, 197, 253, alpha), width=int(size * 0.01))

    # 底部水面
    water_base_y = size * 0.92
    for wave_y_off in range(3):
        wave_points = []
        y_base = water_base_y + wave_y_off * size * 0.015
        for x in range(0, size + 1, 5):
            wave = math.sin(x * 0.012 + wave_y_off * 0.8) * size * 0.008
            wave_points.append((x, y_base + wave))
        wave_points.append((size, size))
        wave_points.append((0, size))
        alpha = int(80 * (1 - wave_y_off * 0.3))
        draw.polygon(wave_points, fill=(147, 197, 253, alpha))

    # 装饰性音符符号（淡淡的）
    note_x = size * 0.18
    note_y = size * 0.22
    note_r = size * 0.02
    draw.ellipse(
        [note_x - note_r, note_y - note_r * 0.8, note_x + note_r, note_y + note_r * 0.8],
        fill=(255, 255, 255, 25)
    )
    draw.line(
        [(note_x + note_r, note_y - note_r * 0.8), (note_x + note_r, note_y - size * 0.07)],
        fill=(255, 255, 255, 25),
        width=int(size * 0.008)
    )
    draw.arc(
        [note_x + note_r, note_y - size * 0.07, note_x + size * 0.06, note_y - size * 0.04],
        start=-90, end=90,
        fill=(255, 255, 255, 25),
        width=int(size * 0.008)
    )

    # 应用轻微的模糊让边缘更柔和
    img = img.filter(ImageFilter.SMOOTH)

    return img

if __name__ == '__main__':
    icon_dir = os.path.join(os.path.dirname(__file__), '..', '..', 'icons')
    os.makedirs(icon_dir, exist_ok=True)

    # 生成 1024x1024 主图标
    icon = create_icon(1024)
    output_path = os.path.join(icon_dir, 'icon.png')
    icon.save(output_path, 'PNG')
    print(f'Generated: {output_path}')

    # 生成多种尺寸
    for s in [32, 64, 128, 256, 512]:
        resized = create_icon(s)
        output = os.path.join(icon_dir, f'icon_{s}x{s}.png')
        resized.save(output, 'PNG')
        print(f'Generated: {output}')

    # 生成 .ico 文件（Windows）
    icon_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_path = os.path.join(icon_dir, 'icon.ico')
    base_icon = create_icon(256)
    ico_images = []
    for w, h in icon_sizes:
        img = base_icon.resize((w, h), Image.LANCZOS)
        ico_images.append(img)
    ico_images[0].save(ico_path, format='ICO', sizes=icon_sizes, append_images=ico_images[1:])
    print(f'Generated: {ico_path}')
