from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math
import os

def create_icon(size=1024):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角背景 - 宣纸色
    radius = int(size * 0.1875)
    bg_img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg_img)

    # 宣纸色渐变
    for y in range(size):
        t = y / size
        r = int(245 - t * 8)
        g = int(242 - t * 10)
        b = int(235 - t * 12)
        bg_draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    # 创建圆角遮罩
    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)

    bg_img.putalpha(mask)
    img.paste(bg_img, (0, 0), bg_img)

    draw = ImageDraw.Draw(img)

    # ========== 远山（最淡的墨色） ==========
    far_mountain_color = (156, 163, 175, 100)
    far_points = []
    peaks_far = [
        (0.0, 0.72), (0.15, 0.65), (0.28, 0.68),
        (0.42, 0.58), (0.55, 0.64), (0.68, 0.59),
        (0.82, 0.66), (1.0, 0.62)
    ]
    for i, (x_ratio, y_ratio) in enumerate(peaks_far):
        x = x_ratio * size
        y = y_ratio * size
        far_points.append((x, y))
    far_points.append((size, size))
    far_points.append((0, size))
    draw.polygon(far_points, fill=far_mountain_color)

    # 远山模糊效果
    img = img.filter(ImageFilter.GaussianBlur(radius=max(1, size * 0.003)))
    draw = ImageDraw.Draw(img)

    # ========== 中景山（中等墨色） ==========
    mid_mountain_color = (107, 114, 128, 190)
    mid_points = []
    peaks_mid = [
        (0.0, 0.80), (0.12, 0.72), (0.25, 0.76),
        (0.38, 0.64), (0.5, 0.72), (0.62, 0.66),
        (0.76, 0.74), (0.88, 0.70), (1.0, 0.72)
    ]
    for i, (x_ratio, y_ratio) in enumerate(peaks_mid):
        x = x_ratio * size
        y = y_ratio * size
        mid_points.append((x, y))
    mid_points.append((size, size))
    mid_points.append((0, size))
    draw.polygon(mid_points, fill=mid_mountain_color)

    # ========== 近景主峰（浓墨 - 高山） ==========
    main_mountain_color = (31, 41, 55, 245)
    main_peaks = [
        (0.20, 0.86),  # 左山脚
        (0.35, 0.56),  # 左峰
        (0.45, 0.66),  # 山谷
        (0.55, 0.44),  # 主峰
        (0.65, 0.60),  # 右谷
        (0.74, 0.50),  # 右峰
        (0.84, 0.70),  # 右山脚
        (0.82, 0.86),  # 右下
    ]
    main_points = [(x * size, y * size) for x, y in main_peaks]
    draw.polygon(main_points, fill=main_mountain_color)

    # ========== 山顶云烟留白 ==========
    cloud_color = (245, 242, 235, 200)
    # 主峰云
    draw.arc(
        [0.50 * size, 0.45 * size, 0.60 * size, 0.54 * size],
        start=200, end=340,
        fill=cloud_color,
        width=max(2, int(size * 0.01))
    )
    # 左峰云
    draw.arc(
        [0.30 * size, 0.58 * size, 0.40 * size, 0.66 * size],
        start=200, end=340,
        fill=(245, 242, 235, 150),
        width=max(1, int(size * 0.008))
    )
    # 右峰云
    draw.arc(
        [0.68 * size, 0.52 * size, 0.78 * size, 0.60 * size],
        start=200, end=340,
        fill=(245, 242, 235, 170),
        width=max(2, int(size * 0.009))
    )

    # ========== 流水（瀑布） ==========
    water_x_center = 0.50 * size
    water_start_y = 0.68 * size
    water_end_y = 0.96 * size

    # 主瀑布
    for i in range(2):
        offset_x = (i - 0.5) * size * 0.03
        points_water = []
        for y in range(int(water_start_y), int(water_end_y), max(2, int(size * 0.005))):
            wave = math.sin((y - water_start_y) * 0.04 + i * 1.5) * size * 0.015
            x = water_x_center + offset_x + wave
            points_water.append((x, y))

        for j in range(len(points_water) - 1):
            x1, y1 = points_water[j]
            x2, y2 = points_water[j + 1]
            alpha = int(140 * (1 - j / len(points_water) * 0.4))
            draw.line(
                [(x1, y1), (x2, y2)],
                fill=(107, 114, 128, alpha),
                width=max(2, int(size * 0.014 - i * size * 0.004))
            )

    # ========== 底部水面波纹（流水） ==========
    water_base_y = 0.91 * size
    for wave_idx in range(2):
        wave_points = []
        y_base = water_base_y + wave_idx * size * 0.018
        for x in range(0, size + 1, max(3, int(size * 0.01))):
            wave = math.sin(x * 0.012 + wave_idx * 1.2) * size * 0.008
            wave_points.append((x, y_base + wave))
        wave_points.append((size, size))
        wave_points.append((0, size))
        alpha = int(50 - wave_idx * 20)
        draw.polygon(wave_points, fill=(75, 85, 99, alpha))

    # ========== 左下角古琴琴弦装饰（呼应高山流水遇知音） ==========
    guqin_x = 0.13 * size
    guqin_y = 0.74 * size
    string_count = 5
    string_gap = size * 0.014
    string_height = size * 0.09
    string_color = (31, 41, 55, 80)

    for i in range(string_count):
        x = guqin_x + i * string_gap
        draw.line(
            [(x, guqin_y), (x, guqin_y + string_height)],
            fill=string_color,
            width=max(1, int(size * 0.003))
        )

    # 琴弦上的"徽位"（横点）
    for y_off in [string_height * 0.3, string_height * 0.7]:
        draw.line(
            [(guqin_x - size * 0.006, guqin_y + y_off),
             (guqin_x + string_gap * (string_count - 1) + size * 0.006, guqin_y + y_off)],
            fill=(31, 41, 55, 50),
            width=max(1, int(size * 0.002))
        )

    # ========== 右上印章式点缀（朱红印章） ==========
    seal_x = 0.78 * size
    seal_y = 0.13 * size
    seal_size = size * 0.055
    seal_color = (185, 28, 28, 160)

    # 印章边框
    draw.rounded_rectangle(
        [seal_x, seal_y, seal_x + seal_size, seal_y + seal_size],
        radius=seal_size * 0.12,
        outline=seal_color,
        width=max(2, int(size * 0.004))
    )

    # 印章文字 - "山"
    try:
        font_size = int(seal_size * 0.65)
        font = ImageFont.truetype("simhei.ttf", font_size)
    except:
        try:
            font = ImageFont.truetype("msyh.ttc", font_size)
        except:
            font = ImageFont.load_default()

    char = "山"
    bbox = draw.textbbox((0, 0), char, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    text_x = seal_x + (seal_size - text_w) / 2
    text_y = seal_y + (seal_size - text_h) / 2 - bbox[1]
    draw.text((text_x, text_y), char, fill=seal_color, font=font)

    # ========== 整体柔和处理 ==========
    img = img.filter(ImageFilter.SMOOTH)

    return img

if __name__ == '__main__':
    icon_dir = os.path.join(os.path.dirname(__file__), '..', 'icons')
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
