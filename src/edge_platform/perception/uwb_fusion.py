"""UWB 坐标融合：多帧置信度加权平均与置信度估计。

对应 spec「感知融合层」：将同一人员在时间窗内的多帧 UWB 读数融合为单一位置，
置信度由基站数量与丢包率共同决定。纯 Python 标准库实现（无 numpy，向量为手写）。
"""


def fuse_uwb_positions(samples):
    """融合同一人员的多帧 UWB 位置。

    :param samples: UWB 读数列表，每项形如
        ``{"x", "y", "z", "confidence", "ts", "beacon_ids"}``（同一时间窗内）。
    :return: 融合后的 ``{"x", "y", "z", "confidence"}``；输入为空或全零权重返回 None。

    融合策略：位置取置信度加权平均；融合置信度取各帧均值并按帧数小幅奖励（多帧一致
    更稳定），上限 1.0。置信度 <= 0 的帧不参与加权。
    """
    if not samples:
        return None

    total_w = 0.0
    sx = sy = sz = 0.0
    confs = []
    for s in samples:
        try:
            w = float(s.get("confidence", 0.0))
        except (TypeError, ValueError, AttributeError):
            w = 0.0
        if w <= 0.0:
            confs.append(0.0)
            continue
        sx += float(s.get("x", 0.0)) * w
        sy += float(s.get("y", 0.0)) * w
        sz += float(s.get("z", 0.0)) * w
        total_w += w
        confs.append(max(0.0, min(1.0, w)))

    if total_w <= 0.0:
        return None

    fx = sx / total_w
    fy = sy / total_w
    fz = sz / total_w

    # 融合置信度：均值 + 多帧一致性奖励（每多一帧 +0.02，上限 +0.1）
    nonzero = [c for c in confs if c > 0.0]
    avg_conf = (sum(nonzero) / len(nonzero)) if nonzero else 0.0
    bonus = min(0.1, 0.02 * (len(nonzero) - 1)) if len(nonzero) > 1 else 0.0
    fused_conf = max(0.0, min(1.0, avg_conf + bonus))

    return {"x": fx, "y": fy, "z": fz, "confidence": fused_conf}


def estimate_uwb_confidence(num_beaacons, packet_loss_pct):
    """根据基站数与丢包率估计 UWB 置信度。

    基站越多、丢包越低则置信度越高：
    - 基站得分：3 基站起基本可用，4 基站趋于饱和（num/4 钳制到 1）。
    - 丢包得分：1 - loss/100。
    - 综合：0.6 * 基站得分 + 0.4 * 丢包得分。

    :param num_beaacons: 参与定位的 UWB 基站数。
    :param packet_loss_pct: 丢包率（0..100）。
    :return: 置信度（0..1）。
    """
    num = max(0, int(num_beaacons))
    loss = max(0.0, min(100.0, float(packet_loss_pct)))
    beacon_score = min(1.0, num / 4.0)
    loss_score = 1.0 - loss / 100.0
    conf = 0.6 * beacon_score + 0.4 * loss_score
    return max(0.0, min(1.0, conf))
