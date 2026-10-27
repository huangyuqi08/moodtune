"""
tools/deploy_github.py —— 把本目录发布到 GitHub 仓库并启用 GitHub Pages

为什么不用 git push：
  本机到 github.com:443 不可达（连接超时），SSH 22/443 也被 reset，
  但 api.github.com 可以正常访问。因此改用 GitHub REST API 的 Git Data 接口
  （blobs → trees → commits → refs）直接构造提交，等效于一次 git push。

用法：
  set GITHUB_TOKEN=xxx          (Windows cmd)
  export GITHUB_TOKEN=xxx       (bash)
  python tools/deploy_github.py
  python tools/deploy_github.py --repo moodtune --private

环境变量：
  GITHUB_TOKEN   必填，需要 repo 权限
  HTTPS_PROXY    可选，走代理时设置
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.github.com'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 不纳入仓库的路径
SKIP_DIRS = {'.workbuddy', '.git', '__pycache__', 'node_modules'}
SKIP_FILES = {'.DS_Store', 'Thumbs.db'}

# 各扩展名的 git blob 模式
MODE_FILE = '100644'


def make_opener(token):
    proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
    else:
        handlers.append(urllib.request.ProxyHandler({}))
    opener = urllib.request.build_opener(*handlers)
    opener.addheaders = [
        ('Authorization', 'token ' + token),
        ('Accept', 'application/vnd.github+json'),
        ('User-Agent', 'moodtune-deploy'),
        ('X-GitHub-Api-Version', '2022-11-28'),
    ]
    return opener


def call(opener, method, path, payload=None, allow=()):
    """调用 GitHub API，返回 (status, data)。allow 中的状态码视为成功。"""
    url = path if path.startswith('http') else API + path
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with opener.open(req, timeout=120) as r:
            body = r.read()
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {'raw': body.decode('utf-8', 'ignore')[:400]}
        if e.code in allow:
            return e.code, parsed
        raise RuntimeError('HTTP %s %s %s -> %s' % (e.code, method, path, parsed))


def collect_files(root):
    """遍历项目，返回 [(相对路径, 本地绝对路径)]"""
    items = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith('.git')]
        for fn in filenames:
            if fn in SKIP_FILES:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace('\\', '/')
            items.append((rel, full))
    items.sort(key=lambda x: x[0])
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default='moodtune', help='仓库名，默认 moodtune')
    ap.add_argument('--private', action='store_true', help='创建私有仓库（Pages 需付费账户）')
    ap.add_argument('--message', default='feat: MoodTune 人脸情绪识别歌曲推荐系统', help='提交说明')
    args = ap.parse_args()

    token = os.environ.get('GITHUB_TOKEN')
    if not token:
        print('缺少 GITHUB_TOKEN 环境变量')
        return 1

    opener = make_opener(token)

    # 1) 当前用户
    st, me = call(opener, 'GET', '/user')
    owner = me['login']
    print('账户：%s' % owner)

    # 2) 建仓库（已存在则复用）
    st, repo = call(opener, 'POST', '/user/repos', {
        'name': args.repo,
        'description': '基于人脸情绪识别的歌曲推荐系统（HTML5 + CSS3 + JS + Vue3，本地 face-api 推理）',
        'private': bool(args.private),
        'auto_init': True,          # 先生成一个初始 commit，便于在其 tree 上叠加
        'has_issues': True,
        'has_wiki': False,
    }, allow=(422,))

    if st == 422:
        print('仓库已存在，复用 %s/%s' % (owner, args.repo))
        st, repo = call(opener, 'GET', '/repos/%s/%s' % (owner, args.repo))
    else:
        print('已创建仓库 %s/%s' % (owner, args.repo))

    full = '%s/%s' % (owner, args.repo)

    # 3) 取默认分支头 commit 与其 tree
    st, ref = call(opener, 'GET', '/repos/%s/git/ref/heads/main' % full, allow=(404,))
    base_commit = base_tree = None
    if st == 200:
        base_commit = ref['object']['sha']
        st2, c = call(opener, 'GET', '/repos/%s/git/commits/%s' % (full, base_commit))
        base_tree = c['tree']['sha']
        print('基线 commit：%s' % base_commit[:8])
    else:
        print('仓库暂无 main 分支，将创建首个 commit')

    # 4) 逐个上传 blob
    files = collect_files(ROOT)
    print('待上传 %d 个文件' % len(files))
    tree_entries = []
    total = 0
    for i, (rel, full_path) in enumerate(files, 1):
        with open(full_path, 'rb') as f:
            raw = f.read()
        total += len(raw)
        content = base64.b64encode(raw).decode('ascii')
        st, blob = call(opener, 'POST', '/repos/%s/git/blobs' % full,
                        {'content': content, 'encoding': 'base64'})
        tree_entries.append({
            'path': rel, 'mode': MODE_FILE, 'type': 'blob', 'sha': blob['sha'],
        })
        print('  [%2d/%d] %-52s %7.1f KB' % (i, len(files), rel, len(raw) / 1024.0))

    print('合计 %.1f MB' % (total / 1048576.0))

    # 5) 建 tree（叠加在基线 tree 上，保证覆盖同名文件）
    tree_payload = {'tree': tree_entries}
    if base_tree:
        tree_payload['base_tree'] = base_tree
    st, tree = call(opener, 'POST', '/repos/%s/git/trees' % full, tree_payload)

    # 6) 建 commit
    commit_payload = {
        'message': args.message,
        'tree': tree['sha'],
        'parents': [base_commit] if base_commit else [],
    }
    st, commit = call(opener, 'POST', '/repos/%s/git/commits' % full, commit_payload)
    print('commit：%s' % commit['sha'][:8])

    # 7) 更新 / 创建 main 分支引用
    if base_commit:
        st, _ = call(opener, 'PATCH', '/repos/%s/git/refs/heads/main' % full,
                     {'sha': commit['sha'], 'force': False})
        print('已更新 main 分支')
    else:
        st, _ = call(opener, 'POST', '/repos/%s/git/refs' % full,
                     {'ref': 'refs/heads/main', 'sha': commit['sha']})
        print('已创建 main 分支')

    # 8) 启用 GitHub Pages（source = main 分支根目录）
    st, pg = call(opener, 'POST', '/repos/%s/pages' % full, {
        'source': {'branch': 'main', 'path': '/'},
    }, allow=(409, 422, 403))

    if st in (201, 409):
        print('GitHub Pages 已启用（main / 根目录）')
    elif st == 422:
        # 已存在时改用 PUT 更新
        st, pg = call(opener, 'PUT', '/repos/%s/pages' % full, {
            'source': {'branch': 'main', 'path': '/'},
        }, allow=(403, 422))
        print('GitHub Pages 配置已更新')
    elif st == 403:
        print('Pages 启用失败（可能为私有仓库或权限不足）：%s' % pg.get('message'))

    url = 'https://%s.github.io/%s/' % (owner.lower(), args.repo)
    print('\n仓库地址：https://github.com/%s' % full)
    print('预览地址：%s' % url)
    print('（Pages 首次构建约需 1~3 分钟）')

    # 9) 顺手输出 Pages 状态
    st, pg2 = call(opener, 'GET', '/repos/%s/pages' % full, allow=(404,))
    if st == 200:
        print('Pages 状态：%s  地址：%s' % (pg2.get('status'), pg2.get('html_url')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
