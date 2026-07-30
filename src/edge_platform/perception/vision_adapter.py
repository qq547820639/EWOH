"""视觉检测与骨架接入：结构化检测结果、骨架到姿态的粗估、像平面到地面的反投影。

对应 spec「摄像头接入与边缘视觉」与「感知融合层」：中心平台只接收边缘侧结构化结果
（bbox + 骨架 + 置信度 + 摄像头 ID + 模型版本），不依赖原始视频。每个识别结果附带
置信度/摄像头 ID/模型版本，可追溯。

仅使用 Python 标准库 math（atan2）实现小向量运算，无 numpy。
"""

import math
from dataclasses import dataclass, field
from typing import Optional, Tuple, Dict, Any


@dataclass
class VisionDetection:
    """视觉检测与骨架结果（边缘侧人体检测 + 骨架提取后上报的结构化结果）。

    bbox_xyxy 为像素或归一化坐标（反投影 project_to_floor 默认按归一化 [0,1] 处理）；
    skeleton_json 为 ``关节名 -> [x, y, conf]`` 的字典；confidence 为检测置信度；
    source_type 区分 real/controlled_test/simulated；model_version 用于结果可追溯。
    """
    camera_id: str
    track_id: str
    bbox_xyxy: Tuple[float, float, float, float]
    skeleton_json: Dict[str, list] = field(default_factory=dict)
    confidence: float = 0.0
    ts: str = ""
    source_type: str = "real"
    model_version: str = ""


def bbox_center(bbox_xyxy):
    """计算检测框中心点 ``(cx, cy)``。"""
    x1, y1, x2, y2 = bbox_xyxy
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def skeleton_to_posture(skeleton_json):
    """由骨架关节粗估人体姿态。

    输入 ``skeleton_json``：``{关节名: [x, y, conf]}``，需至少包含 ``hip`` 与 ``neck``。
    由 hip->neck 向量相对竖直方向的倾角估计躯干俯仰角 ``trunk_pitch_deg``：

    - 图像 y 轴向下：neck 在 hip 正上方时 dy_up = hy - ny > 0，dx = nx - hx = 0，
      倾角为 0（直立）。
    - neck 水平偏离 hip 越多，倾角越大（前倾/侧倾）；neck 不在 hip 上方时视为严重前倾。

    :return: ``{"trunk_pitch_deg": float, "lean": str}``，lean 为
        ``upright``(<15°) / ``leaning``(<45°) / ``bent``(>=45°)；骨架不完整返回 None。
    """
    if not skeleton_json:
        return None
    hip = skeleton_json.get("hip") or skeleton_json.get("hips")
    neck = skeleton_json.get("neck")
    if not hip or not neck:
        return None
    if len(hip) < 2 or len(neck) < 2:
        return None
    hx, hy = float(hip[0]), float(hip[1])
    nx, ny = float(neck[0]), float(neck[1])
    dx = nx - hx
    dy_up = hy - ny  # neck 在 hip 上方时为正
    if dy_up <= 0.0:
        # neck 不在 hip 上方，视为严重前倾
        trunk_pitch_deg = 90.0
    else:
        trunk_pitch_deg = math.degrees(math.atan2(abs(dx), dy_up))

    if trunk_pitch_deg < 15.0:
        lean = "upright"
    elif trunk_pitch_deg < 45.0:
        lean = "leaning"
    else:
        lean = "bent"
    return {"trunk_pitch_deg": trunk_pitch_deg, "lean": lean}


def project_to_floor(bbox_xyxy, camera_pose, camera_height_m, fov_v_deg):
    """简单针孔反投影：由人体检测框估计地面平面坐标 ``(x, y, confidence)``。

    关键假设（V0.8 简化模型，文档化清晰）：
    1. ``bbox_xyxy`` 为归一化图像坐标 ``[0, 1]``（左上 (0,0)、右下 (1,1)，y 向下）；
       像素坐标需调用方先归一化（无图像尺寸时无法反投影）。
    2. 相机安装于 ``camera_height_m`` 高度，光轴水平（无俯仰角），仅 ``camera_pose.yaw_deg``
       决定水平朝向；yaw 约定沿用空间底座：0=朝正北(+Y)，顺时针。
    3. 取检测框底边中心为脚部像点（人立于地面 z=0）。
    4. 垂直方向归一化焦距 fy = 0.5 / tan(fov_v/2)；水平方向假设方形像素 fx = fy。

    反投影步骤：脚部像点 -> 光轴下方俯角 angle_below = atan((foot_y-0.5)/fy) ->
    水平距离 forward = h / tan(angle_below) -> 水平方位 azimuth = atan((foot_x-0.5)/fy) ->
    侧向 lateral = forward * tan(azimuth) -> 经相机 yaw 旋转到工厂坐标系。

    :return: ``(world_x, world_y, confidence)``；脚部在光轴上方或投影失败返回 None。
    """
    x1, y1, x2, y2 = bbox_xyxy
    foot_x = (float(x1) + float(x2)) / 2.0
    foot_y = float(y2)  # 检测框底边为脚部
    h = float(camera_height_m)
    if h <= 0.0:
        return None

    fov_v = float(fov_v_deg)
    if fov_v <= 0.0 or fov_v >= 180.0:
        return None
    fy = 0.5 / math.tan(math.radians(fov_v) / 2.0)

    dy = foot_y - 0.5  # 脚部相对图像中心的垂直偏移，向下为正
    dx = foot_x - 0.5  # 水平偏移，向右为正
    if dy <= 0.0:
        # 脚部在光轴上方或同高，无法投影到地面
        return None
    angle_below = math.atan2(dy, fy)  # 光轴下方俯角（弧度，正）
    forward = h / math.tan(angle_below)
    if forward <= 0.0:
        return None
    azimuth = math.atan2(dx, fy)  # 水平方位角（右为正）
    lateral = forward * math.tan(azimuth)

    # 相机局部系 -> 工厂坐标系：local +X=前向，local +Y=左手侧（沿用空间底座约定）
    theta = math.radians(camera_pose.yaw_deg)
    sin_t, cos_t = math.sin(theta), math.cos(theta)
    wx = sin_t * forward - cos_t * lateral + camera_pose.x
    wy = cos_t * forward + sin_t * lateral + camera_pose.y

    # 置信度：基准 0.6；俯角过小（过远）或过大（过近/畸变）时降低
    conf = 0.6
    angle_below_deg = math.degrees(angle_below)
    if angle_below_deg < 5.0 or angle_below_deg > 80.0:
        conf *= 0.6
    return (wx, wy, max(0.0, min(1.0, conf)))
