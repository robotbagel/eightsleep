FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates libgles2 libegl1 libgl1 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "mediapipe==0.10.*" numpy
RUN mkdir /models \
    && curl -fsSL -o /models/yamnet.tflite https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/latest/yamnet.tflite \
    && curl -fsSL -o /models/efficientdet.tflite https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float32/latest/efficientdet_lite2.tflite
# MediaPipe and matplotlib write caches under $HOME; the app user has none.
ENV HOME=/tmp MPLCONFIGDIR=/tmp
WORKDIR /app
COPY night_ears.py .
USER 1000:1000
CMD ["python", "-u", "night_ears.py"]
