"""RSS 새 글 → Slack 알림 (범용 예제, 기본값: Hacker News 최신 글)

사용:
  SLACK_WEBHOOK_URL=https://hooks.slack.com/... python rss_watch.py
  # 로컬에서 계속 돌리며 테스트하려면 INTERVAL(초) 지정
  INTERVAL=60 SLACK_WEBHOOK_URL=... python rss_watch.py

환경변수:
  FEED_URL           감시할 RSS/Atom 주소 (기본: Hacker News newest)
  SITE_NAME          알림에 표시할 이름 (기본: Hacker News)
  MAX_NOTIFY         한 번 실행에 보낼 최대 알림 수 (기본 10, 넘치면 요약 한 줄)
  SLACK_WEBHOOK_URL  없으면 Slack 대신 화면에만 출력 (dry-run)
  SEEN_FILE          본 글 저장 파일 (기본: seen.json)
  INTERVAL           0보다 크면 그 초마다 반복 실행
"""
import json
import os
import sys
import time
from pathlib import Path

import feedparser
import requests

# 같은 폴더의 .env 파일에서 환경변수 불러오기 (로컬 실행용, 없으면 건너뜀)
# 이미 설정된 환경변수(예: GitHub Actions Secret)는 덮어쓰지 않음
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).with_name(".env"))
except ImportError:
    pass

# Hacker News 최신 글 (1~2분에 한 개꼴). count=50: 실행이 밀려도 놓치지 않게 넉넉히
FEED_URL = os.environ.get("FEED_URL", "https://hnrss.org/newest?count=50")
SITE_NAME = os.environ.get("SITE_NAME", "Hacker News")
MAX_NOTIFY = max(1, int(os.environ.get("MAX_NOTIFY", "10")))  # 한 번 실행에 보낼 최대 알림 수
WEBHOOK = os.environ.get("SLACK_WEBHOOK_URL")
SEEN_FILE = Path(os.environ.get("SEEN_FILE", "seen.json"))
INTERVAL = int(os.environ.get("INTERVAL", "0"))
HEADERS = {"User-Agent": "Mozilla/5.0 (rss-watch example)"}
MAX_SEEN = 1000


def fetch_posts():
    resp = requests.get(FEED_URL, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    feed = feedparser.parse(resp.content)
    if feed.bozo and not feed.entries:
        raise RuntimeError(f"RSS 파싱 실패: {feed.bozo_exception}")
    posts = []
    for e in feed.entries:
        link = e.get("link", "")
        key = e.get("id") or link  # guid가 있으면 guid, 없으면 링크로 식별
        if key:
            posts.append({"key": key, "title": e.get("title", "(제목 없음)").strip(),
                          "url": link})
    return posts


def notify(post):
    title = (post["title"].replace("&", "&amp;")
             .replace("<", "&lt;").replace(">", "&gt;"))
    notify_text(f"📢 *{SITE_NAME} 새 글*\n<{post['url']}|{title}>")


def notify_text(text):
    if not WEBHOOK:
        print("[dry-run]", text.replace("\n", " | "))
        return
    r = requests.post(WEBHOOK, json={"text": text}, timeout=20)
    r.raise_for_status()


def load_seen():
    if not SEEN_FILE.exists():
        return None
    return json.loads(SEEN_FILE.read_text(encoding="utf-8"))


def run_once():
    posts = fetch_posts()
    seen = load_seen()

    if seen is None:  # 첫 실행: 현재 글은 저장만, 알림 생략
        seen = [p["key"] for p in posts]
        print(f"첫 실행: {len(posts)}건 저장, 알림 생략")
    else:
        seen_set = set(seen)
        new = [p for p in posts if p["key"] not in seen_set]
        ordered = list(reversed(new))  # 피드는 보통 최신순 → 오래된 것부터 알림
        to_send, skipped = ordered[-MAX_NOTIFY:], ordered[:-MAX_NOTIFY]
        if skipped:  # 너무 많이 쌓였으면 오래된 건 묶어서 한 줄로
            notify_text(f"📢 *{SITE_NAME}* 새 글이 많아 {len(skipped)}건은 생략했어요")
        for p in to_send:
            notify(p)
        seen.extend(p["key"] for p in ordered)
        print(f"[{time.strftime('%H:%M:%S')}] 새 글 {len(new)}건")

    SEEN_FILE.write_text(json.dumps(seen[-MAX_SEEN:], ensure_ascii=False),
                         encoding="utf-8")


if __name__ == "__main__":
    if INTERVAL > 0:
        print(f"{FEED_URL} 를 {INTERVAL}초마다 확인합니다. (Ctrl+C로 종료)")
        while True:
            try:
                run_once()
            except Exception as e:  # noqa: BLE001
                print(f"[error] {e}", file=sys.stderr)
            time.sleep(INTERVAL)
    else:
        run_once()
