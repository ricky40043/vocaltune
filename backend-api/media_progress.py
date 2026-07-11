def map_demucs_progress(percent: int) -> int:
    """將 Demucs 0-100 映射到整體工作的 5-85，保留前後處理階段。"""
    bounded = max(0, min(100, int(percent)))
    return min(85, 5 + round(bounded * 0.8))
