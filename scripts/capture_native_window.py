"""Capture a screenshot of the currently-running native yuzuki window."""
import os, sys
try:
    import win32gui, win32ui, win32con
except ImportError:
    print("pywin32 not installed; skipping screenshot")
    sys.exit(0)

def find_window_by_title(needle):
    found = []
    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            t = win32gui.GetWindowText(hwnd)
            if needle.lower() in t.lower():
                found.append((hwnd, t))
    win32gui.EnumWindows(cb, None)
    return found

hits = find_window_by_title("yuzuki") + find_window_by_title("Yuzuki")
if not hits:
    print("No yuzuki window found by title")
    sys.exit(1)
print("Found windows:", hits)

hwnd, title = hits[0]
# Bring to foreground so the screenshot is reliable
try:
    win32gui.SetForegroundWindow(hwnd)
except Exception as e:
    print("SetForegroundWindow failed:", e)

l, t, r, b = win32gui.GetWindowRect(hwnd)
w, h = r - l, b - t
print(f"Window rect: ({l},{t}) {w}x{h}")
if w <= 0 or h <= 0:
    print("Window has zero area")
    sys.exit(1)

hwnd_dc = win32gui.GetWindowDC(hwnd)
mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
save_dc = mfc_dc.CreateCompatibleDC()
bmp = win32ui.CreateBitmap()
bmp.CreateCompatibleBitmap(mfc_dc, w, h)
save_dc.SelectObject(bmp)
# BitBlt only works when the window is fully on-screen & topmost; for
# occluded DWM-rendered windows we must use PrintWindow with
# PW_RENDERFULLCONTENT (0x00000002) to ask DWM to redraw into our DC.
import ctypes
user32 = ctypes.windll.user32
# PrintWindow via ctypes (pywin32 doesn't always expose it).
def print_window(hwnd, hdc, flags):
    return user32.PrintWindow(hwnd, hdc, flags)

# ...later, replacing the BitBlt block:
PW_RENDERFULLCONTENT = 0x00000002
res = print_window(hwnd, save_dc.GetSafeHdc(), PW_RENDERFULLCONTENT)
print(f"PrintWindow returned {res} (1=ok)")

out = os.path.abspath("yuzuki_native_window.png")
bmp.SaveBitmapFile(save_dc, out)
print(f"Saved screenshot: {out} ({os.path.getsize(out)} bytes)")

# cleanup
save_dc.DeleteDC()
mfc_dc.DeleteDC()
win32gui.ReleaseDC(hwnd, hwnd_dc)
win32gui.DeleteObject(bmp.GetHandle())
