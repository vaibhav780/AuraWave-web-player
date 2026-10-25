#!/usr/bin/env python3
"""
AuraWave Windows Service Manager
================================

Controls the AuraWave Windows Service:
- Checks service installation & running status
- Installs service with Automatic startup (starts on Windows boot)
- Starts, stops, and removes the service
- Elevates via UAC when administrative privileges are required
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import socket
import subprocess
import sys
import time
from typing import Dict, Optional, Tuple

SERVICE_NAME = "AuraWaveMusicServer"
SERVICE_DISPLAY_NAME = "AuraWave Desktop Music Server"
SERVICE_DESCRIPTION = "AuraWave Desktop Music Server streaming audio on port 8080 from D:\\songs"

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_EXE = os.path.join(HERE, "AuraWaveService.exe")
STATE_FILE = os.path.join(HERE, "service_state.json")
CONFIG_FILE = os.path.join(HERE, "config.json")


def is_admin() -> bool:
    """Return True if running with Administrator privileges."""
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False


def is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """Return True if a server is listening on host:port."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


def get_service_state_file() -> Optional[dict]:
    """Read service_state.json if available."""
    if os.path.isfile(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def get_service_status() -> Dict[str, any]:
    """Query Windows Service Control Manager for AuraWaveMusicServer."""
    res = {
        "installed": False,
        "running": False,
        "status": "NOT_INSTALLED",
        "start_type": "UNKNOWN",
        "pid": None,
        "port": 8080,
    }

    state = get_service_state_file()
    if state and state.get("port"):
        res["port"] = state["port"]
        res["pid"] = state.get("pid")

    try:
        out = subprocess.run(
            ["sc.exe", "query", SERVICE_NAME],
            capture_output=True,
            text=True,
            timeout=5,
        )
        stdout = out.stdout + out.stderr
        if "1060" in stdout or "does not exist" in stdout.lower():
            res["status"] = "NOT_INSTALLED"
            res["installed"] = False
            return res

        res["installed"] = True
        if "RUNNING" in stdout:
            res["running"] = True
            res["status"] = "RUNNING"
        elif "STOPPED" in stdout:
            res["running"] = False
            res["status"] = "STOPPED"
        elif "START_PENDING" in stdout:
            res["running"] = False
            res["status"] = "STARTING"
        elif "STOP_PENDING" in stdout:
            res["running"] = False
            res["status"] = "STOPPING"
        else:
            res["status"] = "UNKNOWN"

        # Query config for startup type
        qc = subprocess.run(
            ["sc.exe", "qc", SERVICE_NAME],
            capture_output=True,
            text=True,
            timeout=5,
        )
        qc_out = qc.stdout
        if "AUTO_START" in qc_out:
            res["start_type"] = "AUTOMATIC"
        elif "DEMAND_START" in qc_out:
            res["start_type"] = "MANUAL"
        elif "DISABLED" in qc_out:
            res["start_type"] = "DISABLED"

    except Exception as exc:
        res["status"] = f"ERROR: {exc}"

    return res


def run_elevated_command(command_str: str) -> Tuple[bool, str]:
    """Run command with elevated privileges using PowerShell Start-Process -Verb RunAs."""
    if is_admin():
        # Already admin, execute directly
        try:
            p = subprocess.run(command_str, shell=True, capture_output=True, text=True, timeout=30)
            return p.returncode == 0, p.stdout + p.stderr
        except Exception as exc:
            return False, str(exc)

    # Trigger UAC prompt via PowerShell
    # We escape double quotes for the inner argument string
    escaped_cmd = command_str.replace('"', '\\"')
    ps_cmd = (
        f'Start-Process cmd.exe -ArgumentList \'/c "{escaped_cmd}"\' -Verb RunAs -Wait'
    )
    try:
        p = subprocess.run(["powershell.exe", "-Command", ps_cmd], timeout=60)
        return p.returncode == 0, "Elevated execution completed."
    except Exception as exc:
        return False, f"Failed to elevate: {exc}"


def ensure_service_exe() -> Tuple[bool, str]:
    """Ensure AuraWaveService.exe exists, compiling it via csc.exe if missing."""
    if os.path.isfile(SERVICE_EXE):
        return True, SERVICE_EXE

    cs_src = os.path.join(HERE, "AuraWaveService.cs")
    if not os.path.isfile(cs_src):
        return False, f"Source file {cs_src} not found."

    csc_path = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if not os.path.isfile(csc_path):
        csc_path = r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    if not os.path.isfile(csc_path):
        return False, "csc.exe (.NET Framework compiler) was not found on this system."

    compile_cmd = (
        f'"{csc_path}" /target:winexe /r:System.ServiceProcess.dll '
        f'/out:"{SERVICE_EXE}" "{cs_src}"'
    )
    success, out = run_elevated_command(compile_cmd)
    if os.path.isfile(SERVICE_EXE):
        return True, SERVICE_EXE
    return False, f"Failed to compile {SERVICE_EXE}: {out}"


def install_service(music_folder: Optional[str] = None, port: Optional[int] = None) -> Tuple[bool, str]:
    """Install AuraWave as a Windows Service configured to start automatically on boot."""
    ok, msg = ensure_service_exe()
    if not ok:
        return False, msg

    # Save initial config if given
    cfg = {}
    if os.path.isfile(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    if music_folder:
        cfg["music_folder"] = music_folder
    if port:
        cfg["port"] = port
    cfg["auto_start"] = True
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass

    # Batch of SC commands to create and configure the service
    # 1. sc create (start= auto ensures it starts on Windows boot)
    # 2. sc description
    # 3. sc failure (auto-recovery on crash)
    cmd = (
        f'sc.exe create {SERVICE_NAME} binPath= "\\"{SERVICE_EXE}\\"" start= auto '
        f'DisplayName= "{SERVICE_DISPLAY_NAME}" && '
        f'sc.exe description {SERVICE_NAME} "{SERVICE_DESCRIPTION}" && '
        f'sc.exe failure {SERVICE_NAME} reset= 60 actions= restart/5000/restart/5000/restart/5000'
    )

    success, out = run_elevated_command(cmd)
    if not success:
        return False, f"Service installation failed: {out}"

    # Also start the service immediately
    start_service()
    return True, "AuraWave Windows Service successfully installed and set to start on Windows boot!"


def uninstall_service() -> Tuple[bool, str]:
    """Stop and delete the AuraWave Windows Service."""
    cmd = f'sc.exe stop {SERVICE_NAME} & sc.exe delete {SERVICE_NAME}'
    success, out = run_elevated_command(cmd)
    # Clean up state file
    if os.path.isfile(STATE_FILE):
        try:
            os.remove(STATE_FILE)
        except Exception:
            pass
    return success, out


def start_service() -> Tuple[bool, str]:
    """Start the AuraWave Windows Service."""
    cmd = f'sc.exe start {SERVICE_NAME}'
    success, out = run_elevated_command(cmd)
    # Wait up to 3 seconds for service to reach RUNNING state
    for _ in range(6):
        time.sleep(0.5)
        st = get_service_status()
        if st["running"]:
            return True, "Service is running."
    return success, out


def stop_service() -> Tuple[bool, str]:
    """Stop the AuraWave Windows Service."""
    cmd = f'sc.exe stop {SERVICE_NAME}'
    success, out = run_elevated_command(cmd)
    for _ in range(6):
        time.sleep(0.5)
        st = get_service_status()
        if not st["running"]:
            return True, "Service stopped."
    return success, out


def restart_service() -> Tuple[bool, str]:
    """Restart the AuraWave Windows Service."""
    stop_service()
    time.sleep(1)
    return start_service()


def main():
    if len(sys.argv) < 2:
        print("Usage: python service_manager.py [status|install|uninstall|start|stop|restart]")
        sys.exit(1)

    action = sys.argv[1].lower()
    if action == "status":
        st = get_service_status()
        port_used = is_port_in_use(st.get("port", 8080))
        print("AuraWave Windows Service Status:")
        print(f"  Installed:   {st['installed']}")
        print(f"  Running:     {st['running']}")
        print(f"  State:       {st['status']}")
        print(f"  Start Type:  {st['start_type']} (Starts on Windows Boot: {st['start_type'] == 'AUTOMATIC'})")
        print(f"  Port:        {st['port']} (In Use: {port_used})")
        if st.get("pid"):
            print(f"  PID:         {st['pid']}")
    elif action == "install":
        print("Installing AuraWave Windows Service (Auto-Start on Boot)...")
        ok, msg = install_service()
        print(f"Result: {'SUCCESS' if ok else 'FAILED'}: {msg}")
    elif action == "uninstall":
        print("Uninstalling AuraWave Windows Service...")
        ok, msg = uninstall_service()
        print(f"Result: {'SUCCESS' if ok else 'FAILED'}: {msg}")
    elif action == "start":
        print("Starting AuraWave Windows Service...")
        ok, msg = start_service()
        print(f"Result: {'SUCCESS' if ok else 'FAILED'}: {msg}")
    elif action == "stop":
        print("Stopping AuraWave Windows Service...")
        ok, msg = stop_service()
        print(f"Result: {'SUCCESS' if ok else 'FAILED'}: {msg}")
    elif action == "restart":
        print("Restarting AuraWave Windows Service...")
        ok, msg = restart_service()
        print(f"Result: {'SUCCESS' if ok else 'FAILED'}: {msg}")
    else:
        print(f"Unknown action: {action}")
        sys.exit(1)


if __name__ == "__main__":
    main()
