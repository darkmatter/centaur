"""SVG chart generation for crypto market data.

Generates server-side SVG charts from numeric data. No external dependencies.
Ported from gtmskill's chart-builder.ts.

Charts: line, candlestick (OHLC), comparison (two tokens), and bar.
"""

from __future__ import annotations

import html
from typing import Any


def _fmt_price(n: float) -> str:
    if n >= 1e6:
        return f"{n / 1e6:.2f}M"
    if n >= 1e3:
        return f"{n / 1e3:.1f}K"
    if n >= 1:
        return f"{n:.2f}"
    if n >= 0.01:
        return f"{n:.4f}"
    return f"{n:.6f}"


def _esc(s: str) -> str:
    return html.escape(s, quote=True)


class ChartClient:
    """SVG chart builder."""

    def line_chart(self, data: list[dict], title: str) -> str:
        """Generate a line chart SVG from price data.

        data: list of {date: str, price: float}
        title: chart title (e.g. "SOL 30d")
        Returns: SVG string
        """
        if not data:
            return ""

        w, h = 600, 300
        pad = {"top": 40, "right": 20, "bottom": 50, "left": 70}
        plot_w = w - pad["left"] - pad["right"]
        plot_h = h - pad["top"] - pad["bottom"]

        prices = [d["price"] for d in data]
        min_p = min(prices) * 0.98
        max_p = max(prices) * 1.02
        rng = max_p - min_p or 1

        x_step = plot_w / max(len(data) - 1, 1)
        points = []
        for i, d in enumerate(data):
            x = pad["left"] + i * x_step
            y = pad["top"] + plot_h - ((d["price"] - min_p) / rng) * plot_h
            points.append((x, y, d["date"], d["price"]))

        polyline = " ".join(f"{p[0]:.1f},{p[1]:.1f}" for p in points)

        area_path = (
            f"M{points[0][0]:.1f},{pad['top'] + plot_h:.1f} "
            + " ".join(f"L{p[0]:.1f},{p[1]:.1f}" for p in points)
            + f" L{points[-1][0]:.1f},{pad['top'] + plot_h:.1f} Z"
        )

        # Y-axis labels
        y_labels = []
        for i in range(5):
            val = min_p + (rng * i) / 4
            y = pad["top"] + plot_h - (i / 4) * plot_h
            y_labels.append(
                f'<text x="{pad["left"] - 8}" y="{y + 4}" fill="#9ca3af" font-size="10" text-anchor="end">${_fmt_price(val)}</text>'
                f'\n<line x1="{pad["left"]}" y1="{y}" x2="{w - pad["right"]}" y2="{y}" stroke="#1e1e2e" stroke-width="1"/>'
            )

        # X-axis labels
        step = max(len(data) // 6, 1)
        x_labels = []
        for i, d in enumerate(data):
            if i % step == 0 or i == len(data) - 1:
                x = pad["left"] + i * x_step
                x_labels.append(
                    f'<text x="{x}" y="{h - 10}" fill="#9ca3af" font-size="9" text-anchor="middle">{d["date"][5:]}</text>'
                )

        change = data[-1]["price"] - data[0]["price"] if len(data) >= 2 else 0
        color = "#34d399" if change >= 0 else "#ef4444"
        pct = (change / (data[0]["price"] or 1)) * 100

        return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="background:#0f0f17;border-radius:8px">
  <text x="{pad["left"]}" y="24" fill="#e2e8f0" font-size="14" font-weight="600" font-family="monospace">{_esc(title)}</text>
  <text x="{w - pad["right"]}" y="24" fill="{color}" font-size="12" font-family="monospace" text-anchor="end">${_fmt_price(data[-1]["price"])} ({"+" if change >= 0 else ""}{pct:.1f}%)</text>
  {"".join(y_labels)}
  {"".join(x_labels)}
  <path d="{area_path}" fill="{color}" opacity="0.08"/>
  <polyline points="{polyline}" fill="none" stroke="{color}" stroke-width="2" stroke-linejoin="round"/>
</svg>'''

    def candlestick_chart(self, data: list[dict], title: str) -> str:
        """Generate a candlestick (OHLC) chart SVG.

        data: list of {date: str, open: float, high: float, low: float, close: float}
        title: chart title (e.g. "ETH 30d OHLC")
        Returns: SVG string
        """
        if not data:
            return ""

        w, h = 700, 350
        pad = {"top": 40, "right": 20, "bottom": 50, "left": 70}
        plot_w = w - pad["left"] - pad["right"]
        plot_h = h - pad["top"] - pad["bottom"]

        all_prices = [p for d in data for p in (d["high"], d["low"])]
        min_p = min(all_prices) * 0.995
        max_p = max(all_prices) * 1.005
        rng = max_p - min_p or 1

        candle_w = max(min(plot_w / len(data) - 2, 12), 2)
        gap = (plot_w - candle_w * len(data)) / (len(data) + 1)

        def to_y(price: float) -> float:
            return pad["top"] + plot_h - ((price - min_p) / rng) * plot_h

        candles = []
        for i, d in enumerate(data):
            x = pad["left"] + gap + i * (candle_w + gap)
            bullish = d["close"] >= d["open"]
            color = "#34d399" if bullish else "#ef4444"
            body_top = to_y(max(d["open"], d["close"]))
            body_bot = to_y(min(d["open"], d["close"]))
            body_h = max(body_bot - body_top, 1)
            wick_x = x + candle_w / 2
            candles.append(
                f'<line x1="{wick_x:.1f}" y1="{to_y(d["high"]):.1f}" x2="{wick_x:.1f}" y2="{to_y(d["low"]):.1f}" stroke="{color}" stroke-width="1"/>'
                f'\n<rect x="{x:.1f}" y="{body_top:.1f}" width="{candle_w}" height="{body_h:.1f}" fill="{color}" rx="1" opacity="0.9"/>'
            )

        # Y-axis
        y_labels = []
        for i in range(5):
            val = min_p + (rng * i) / 4
            y = pad["top"] + plot_h - (i / 4) * plot_h
            y_labels.append(
                f'<text x="{pad["left"] - 8}" y="{y + 4}" fill="#9ca3af" font-size="10" text-anchor="end">${_fmt_price(val)}</text>'
                f'\n<line x1="{pad["left"]}" y1="{y}" x2="{w - pad["right"]}" y2="{y}" stroke="#1e1e2e" stroke-width="1"/>'
            )

        # X-axis
        step = max(len(data) // 6, 1)
        x_labels = []
        for i, d in enumerate(data):
            if i % step == 0 or i == len(data) - 1:
                x = pad["left"] + gap + i * (candle_w + gap) + candle_w / 2
                x_labels.append(
                    f'<text x="{x:.1f}" y="{h - 10}" fill="#9ca3af" font-size="9" text-anchor="middle">{d["date"][5:]}</text>'
                )

        change = data[-1]["close"] - data[0]["open"]
        color = "#34d399" if change >= 0 else "#ef4444"
        pct = (change / (data[0]["open"] or 1)) * 100

        return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="background:#0f0f17;border-radius:8px">
  <text x="{pad["left"]}" y="24" fill="#e2e8f0" font-size="14" font-weight="600" font-family="monospace">{_esc(title)}</text>
  <text x="{w - pad["right"]}" y="24" fill="{color}" font-size="12" font-family="monospace" text-anchor="end">${_fmt_price(data[-1]["close"])} ({"+" if change >= 0 else ""}{pct:.1f}%)</text>
  {"".join(y_labels)}
  {"".join(x_labels)}
  {"".join(candles)}
</svg>'''

    def comparison_chart(self, series1: list[dict], series2: list[dict], label1: str, label2: str) -> str:
        """Generate a comparison chart (two tokens, normalized to % change, log scale).

        series1/series2: list of {date: str, price: float}
        label1/label2: token labels (e.g. "ETH", "SOL")
        Returns: SVG string
        """
        if not series1 or not series2:
            return ""

        import math

        # Align by index (simpler, works even if dates differ)
        length = min(len(series1), len(series2))
        s1 = series1[:length]
        s2 = series2[:length]

        w, h = 700, 350
        pad = {"top": 50, "right": 80, "bottom": 50, "left": 70}
        plot_w = w - pad["left"] - pad["right"]
        plot_h = h - pad["top"] - pad["bottom"]

        # Normalize to base 100
        base1 = s1[0]["price"] or 1
        base2 = s2[0]["price"] or 1
        norm1 = [{"date": d["date"], "val": (d["price"] / base1) * 100} for d in s1]
        norm2 = [{"date": d["date"], "val": (d["price"] / base2) * 100} for d in s2]

        all_vals = [d["val"] for d in norm1 + norm2 if d["val"] > 0]
        min_val = min(all_vals) * 0.95
        max_val = max(all_vals) * 1.05
        log_min = math.log10(max(min_val, 0.01))
        log_max = math.log10(max_val)
        log_range = log_max - log_min or 1

        def to_y(val: float) -> float:
            log_val = math.log10(max(val, 0.01))
            return pad["top"] + plot_h - ((log_val - log_min) / log_range) * plot_h

        x_step = plot_w / max(length - 1, 1)
        color1, color2 = "#34d399", "#60a5fa"

        pts1 = " ".join(f"{pad['left'] + i * x_step:.1f},{to_y(d['val']):.1f}" for i, d in enumerate(norm1))
        pts2 = " ".join(f"{pad['left'] + i * x_step:.1f},{to_y(d['val']):.1f}" for i, d in enumerate(norm2))

        pct1 = norm1[-1]["val"] - 100
        pct2 = norm2[-1]["val"] - 100

        # Y-axis
        y_labels = []
        for i in range(5):
            log_val = log_min + (log_range * i) / 4
            val = 10 ** log_val
            y = pad["top"] + plot_h - (i / 4) * plot_h
            pct_label = f"+{val - 100:.0f}%" if val >= 100 else f"{val - 100:.0f}%"
            y_labels.append(
                f'<text x="{pad["left"] - 8}" y="{y + 4}" fill="#9ca3af" font-size="10" text-anchor="end">{pct_label}</text>'
                f'\n<line x1="{pad["left"]}" y1="{y}" x2="{w - pad["right"]}" y2="{y}" stroke="#1e1e2e" stroke-width="1"/>'
            )

        # X-axis
        step = max(length // 6, 1)
        x_labels = []
        for i, d in enumerate(norm1):
            if i % step == 0 or i == length - 1:
                x = pad["left"] + i * x_step
                x_labels.append(
                    f'<text x="{x}" y="{h - 10}" fill="#9ca3af" font-size="9" text-anchor="middle">{d["date"][5:]}</text>'
                )

        return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="background:#0f0f17;border-radius:8px">
  <text x="{w // 2}" y="18" fill="#e2e8f0" font-size="13" font-weight="600" font-family="monospace" text-anchor="middle">{_esc(label1)} vs {_esc(label2)} — Relative Performance (log scale)</text>
  <rect x="{pad["left"]}" y="{pad["top"] - 30}" width="10" height="10" rx="2" fill="{color1}"/>
  <text x="{pad["left"] + 14}" y="{pad["top"] - 21}" fill="{color1}" font-size="11" font-family="monospace">{_esc(label1)} ({"+" if pct1 >= 0 else ""}{pct1:.1f}%)</text>
  <rect x="{pad["left"] + 180}" y="{pad["top"] - 30}" width="10" height="10" rx="2" fill="{color2}"/>
  <text x="{pad["left"] + 194}" y="{pad["top"] - 21}" fill="{color2}" font-size="11" font-family="monospace">{_esc(label2)} ({"+" if pct2 >= 0 else ""}{pct2:.1f}%)</text>
  {"".join(y_labels)}
  {"".join(x_labels)}
  <polyline points="{pts1}" fill="none" stroke="{color1}" stroke-width="2" stroke-linejoin="round"/>
  <polyline points="{pts2}" fill="none" stroke="{color2}" stroke-width="2" stroke-linejoin="round"/>
</svg>'''

    def bar_chart(self, data: list[dict], title: str) -> str:
        """Generate a bar chart SVG.

        data: list of {label: str, value: float}
        title: chart title
        Returns: SVG string
        """
        if not data:
            return ""

        w, h = 600, 300
        pad = {"top": 40, "right": 20, "bottom": 60, "left": 70}
        plot_w = w - pad["left"] - pad["right"]
        plot_h = h - pad["top"] - pad["bottom"]

        max_val = max(d["value"] for d in data) or 1
        bar_w = min(plot_w / len(data) - 4, 40)
        gap = (plot_w - bar_w * len(data)) / (len(data) + 1)

        bars = []
        for i, d in enumerate(data):
            x = pad["left"] + gap + i * (bar_w + gap)
            bar_h = (d["value"] / max_val) * plot_h
            y = pad["top"] + plot_h - bar_h
            bars.append(
                f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w}" height="{bar_h:.1f}" rx="2" fill="#60a5fa" opacity="0.8"/>'
                f'\n<text x="{x + bar_w / 2:.1f}" y="{h - 15}" fill="#9ca3af" font-size="9" text-anchor="middle"'
                f' transform="rotate(-30 {x + bar_w / 2:.1f} {h - 15})">{_esc(d["label"][:12])}</text>'
            )

        return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="background:#0f0f17;border-radius:8px">
  <text x="{pad["left"]}" y="24" fill="#e2e8f0" font-size="14" font-weight="600" font-family="monospace">{_esc(title)}</text>
  {"".join(bars)}
</svg>'''


def _client() -> ChartClient:
    return ChartClient()
