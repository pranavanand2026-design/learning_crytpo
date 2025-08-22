import os
import subprocess
import sys
import platform
import signal

# === Paths ===
base_dir = os.path.dirname(os.path.abspath(__file__))
frontend_path = os.path.join(base_dir, "web_app", "frontend")
requirements_file = os.path.join(base_dir, "requirements.txt")

# === NPM executable (cross-platform) ===
npm_cmd = "npm.cmd" if platform.system() == "Windows" else "npm"

backend = None
frontend = None

try:
    # --- Python dependencies ---
    if os.path.exists(requirements_file):
        print("Installing Python dependencies from requirements.txt ...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-r", requirements_file],
            check=True
        )
    else:
        print("requirements.txt not found, skipping pip install.")

    # --- Django migrations ---
    print("Running Django migrations...")
    subprocess.run([sys.executable, "manage.py", "makemigrations"], check=True)
    subprocess.run([sys.executable, "manage.py", "migrate"], check=True)

    # --- Frontend setup ---
    node_modules_path = os.path.join(frontend_path, "node_modules")
    if not os.path.exists(node_modules_path):
        print("Installing frontend dependencies (npm install)...")
        subprocess.run(
            [npm_cmd, "install"],
            cwd=frontend_path,
            shell=(platform.system() == "Windows"),
            check=True
        )
    else:
        print("node_modules found — skipping npm install.")

    # --- Start backend ---
    print("Starting Django backend at http://127.0.0.1:8000 ...")
    backend = subprocess.Popen(
        [sys.executable, "manage.py", "runserver"],
        cwd=base_dir,
    )

    # --- Start frontend ---
    print("Starting frontend dev server ...")
    frontend = subprocess.Popen(
        [npm_cmd, "run", "dev"],
        cwd=frontend_path,
        shell=(platform.system() == "Windows"),
    )

    # Wait for both processes
    backend.wait()
    frontend.wait()

except KeyboardInterrupt:
    print("\nShutting down servers...")
    for p in [backend, frontend]:
        if p and p.poll() is None:
            try:
                if platform.system() == "Windows":
                    p.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    p.terminate()
            except Exception:
                pass
    print("Servers stopped cleanly.")

except subprocess.CalledProcessError as e:
    print(f"Error: {e}")

finally:
    # Ensure cleanup even if exceptions occur
    for p in [backend, frontend]:
        if p and p.poll() is None:
            p.terminate()
