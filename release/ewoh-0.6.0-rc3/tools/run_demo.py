#!/usr/bin/env python3
"""EWOH 一键演示启动器：拉起 stub 平台并自动打开指挥地图。

等价于「`make run-stub` + 手动开浏览器」，但会等待端口真正就绪后再打开页面，
避免浏览器抢先加载到空白页。跨平台（macOS / Linux / Windows）：使用标准库
`webbrowser` 而非 `open` 命令。

用法：
    python3 tools/run_demo.py                    # 默认 127.0.0.1:8765
    python3 tools/run_demo.py --port 9000        # 指定端口
    python3 tools/run_demo.py --no-browser       # 只启服务，不开浏览器
    python3 tools/run_demo.py --timeout 30       # 调整启动等待上限（秒）

Ctrl-C / SIGINT / SIGTERM 停止；启动器会主动终止后台平台进程及其进程组，不留孤儿进程。

注意：stub 模式数据源为 simulated，仅供工程自测与演示，**不作为真机验收依据**。

纯 Python 标准库实现，无第三方依赖。
"""

import argparse
import contextlib
import os
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_TIMEOUT = 20.0

#: 端口就绪探测间隔（秒）
POLL_INTERVAL = 0.2
#: 子进程优雅退出等待时长（秒），超时后强制 kill
GRACEFUL_STOP_SECONDS = 5.0


def port_is_open(host, port, timeout=0.5):
    """探测 TCP 端口是否可连接。"""
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def wait_for_port(host, port, timeout, proc=None):
    """轮询等待端口就绪。

    返回 True 表示就绪；False 表示超时。若 proc 在等待期间提前退出，立即返回 False
    （避免端口永远等不到时白等满超时）。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            return False  # 平台进程已退出（多半是端口占用或启动异常）
        if port_is_open(host, port):
            return True
        time.sleep(POLL_INTERVAL)
    return False


def start_platform(host, port, stub=True, db=None):
    """后台拉起平台进程，返回 Popen 对象。

    通过 PYTHONPATH=src 解析 edge_platform 包，与 `make run` 保持一致；
    继承父进程的 stdout/stderr，便于直接看到平台日志。
    """
    cmd = [sys.executable, "-m", "edge_platform.run", "--host", host, "--port", str(port)]
    if stub:
        cmd.append("--stub")
    if db:
        cmd.extend(["--db", db])

    env = dict(os.environ)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(SRC_DIR) + (os.pathsep + existing if existing else "")

    # 让子进程进入独立进程组，便于在退出时一次性清理其可能 fork 的孙进程。
    popen_kwargs = {}
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
    else:  # Windows 兜底：用作业/进程组隔离（kill 仅直接子进程，尽力而为）
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

    return subprocess.Popen(  # noqa: S603 - 参数为本地常量，非外部输入
        cmd, cwd=str(REPO_ROOT), env=env, **popen_kwargs
    )


def _kill_process_group(proc, sig):
    """向子进程所在进程组发送信号（POSIX 且已 start_new_session 时有效）。"""
    if os.name != "posix":
        return
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass  # 进程组已不存在


def stop_platform(proc):
    """优雅终止平台进程及其进程组；超时未退出则强制 kill。

    仅靠 proc.terminate() 只能杀直接子进程，若其 fork 了孙进程会残留；
    因此先对整个进程组发 SIGTERM，再直接 terminate 子进程，超时未退出则
    对进程组发 SIGKILL 兜底，确保不留孤儿。
    """
    if proc is None or proc.poll() is not None:
        return
    _kill_process_group(proc, signal.SIGTERM)
    proc.terminate()
    try:
        proc.wait(timeout=GRACEFUL_STOP_SECONDS)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc, signal.SIGKILL)
        proc.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=GRACEFUL_STOP_SECONDS)


def _make_signal_handler(proc, stopped):
    """构造幂等的信号处理器：触发后清理子进程并退出。

    `stopped` 为可变容器（dict），保证 SIGTERM/SIGINT 同时到达或重复到达时
    不会重复执行清理逻辑导致异常。
    """
    def _on_signal(signum, _frame):
        if stopped["flag"]:
            return
        stopped["flag"] = True
        print(f"\n[demo] 收到信号 {signum}，正在关闭平台（避免孤儿进程）...",
              file=sys.stderr)
        stop_platform(proc)
        sys.exit(0)
    return _on_signal


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        prog="run_demo.py",
        description="EWOH 一键演示：启动 stub 平台并打开指挥地图",
        epilog="stub 模式数据源为 simulated，仅供演示，不作为真机验收依据。",
    )
    ap.add_argument("--host", default=DEFAULT_HOST, help="监听地址（默认 %(default)s）")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（默认 %(default)s）")
    ap.add_argument("--db", default=None, help="数据库路径（默认由平台决定）")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                    help="等待平台就绪的秒数上限（默认 %(default)s）")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--real", action="store_true",
                    help="装配真实模块启动（缺失时平台自行回退 stub）")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    url = f"http://{args.host}:{args.port}"

    if port_is_open(args.host, args.port):
        print(f"[demo] 端口 {args.port} 已被占用；若平台已在运行请直接访问 {url}")
        print("[demo] 否则请先停止占用进程，或用 --port 指定其他端口")
        return 1

    print(f"[demo] 正在启动 EWOH 平台（{'real' if args.real else 'stub'} 模式）...")
    proc = start_platform(args.host, args.port, stub=not args.real, db=args.db)

    # 注册信号处理器：SIGTERM / SIGINT 都能主动清理子进程组，避免孤儿进程。
    # 必须在子进程启动后、进入 wait 前注册；用 stopped 标志保证幂等。
    stopped = {"flag": False}
    handler = _make_signal_handler(proc, stopped)
    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)

    try:
        if not wait_for_port(args.host, args.port, args.timeout, proc=proc):
            if proc.poll() is not None:
                print(f"[demo] 平台进程已退出（返回码 {proc.returncode}），启动失败")
            else:
                print(f"[demo] 等待 {args.timeout:.0f}s 后端口仍未就绪，启动超时")
            stop_platform(proc)
            return 1

        print(f"[demo] 平台已就绪：{url}")
        if args.no_browser:
            print("[demo] 已跳过打开浏览器（--no-browser）")
        elif webbrowser.open(url):
            print("[demo] 已在默认浏览器打开指挥地图")
        else:
            print("[demo] 未能自动打开浏览器，请手动访问上述地址")

        print("[demo] 按 Ctrl-C 停止，或发送 SIGTERM/SIGINT 退出")
        proc.wait()
    except KeyboardInterrupt:
        # SIGINT 已被上面的 handler 接管；此处仅作兜底（极端时序窗口）。
        print("\n[demo] 收到停止信号，正在关闭平台...")
    finally:
        if not stopped["flag"]:
            stop_platform(proc)
        print("[demo] 已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
