FROM python:3.12-slim
RUN pip install --no-cache-dir pychromecast==14.*
WORKDIR /app
COPY screen_watch.py .
USER 1000:1000
CMD ["python", "-u", "screen_watch.py"]
