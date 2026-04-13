import cv2
import base64
import os

def extract_frames(video_path, name, intervals_sec):
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total / fps
    print(f"{name}: fps={fps:.1f}, frames={total}, duration={duration:.1f}s")
    frames = []
    for t in intervals_sec:
        if t > duration:
            break
        frame_idx = int(t * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if ret:
            h, w = frame.shape[:2]
            scale = 600 / w
            frame = cv2.resize(frame, (600, int(h * scale)))
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            b64 = base64.b64encode(buf).decode()
            frames.append((t, b64))
    cap.release()
    return frames

os.makedirs("frames_out", exist_ok=True)

v1 = extract_frames("2026-03-11_02-45-44.mp4", "IDEAL", [0, 2, 4, 6, 8, 10, 12, 14])
for t, b64 in v1:
    with open(f"frames_out/ideal_{int(t):02d}s.jpg", "wb") as f:
        f.write(base64.b64decode(b64))
    print(f"saved ideal_{int(t):02d}s.jpg")

v2 = extract_frames("2026-03-11_02-48-57.mp4", "CURRENT", [0, 2, 4, 6, 8, 10, 12])
for t, b64 in v2:
    with open(f"frames_out/current_{int(t):02d}s.jpg", "wb") as f:
        f.write(base64.b64decode(b64))
    print(f"saved current_{int(t):02d}s.jpg")

print("DONE")
