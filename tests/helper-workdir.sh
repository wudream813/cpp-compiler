#!/usr/bin/env bash
# 反文件读写 helper（tools/linux/UnFileIO.cpp）的行为回归测试 —— 7.4.7
# 需要 g++；不依赖 VS Code，可直接运行：bash tests/helper-workdir.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/tools/linux/UnFileIO.cpp"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0
fail=0

ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; echo "      $2"; fail=$((fail+1)); }

cd "$WORK" || exit 1

cat > prog.cpp <<'EOF'
#include <cstdio>
#include <thread>
#include <chrono>
#include <cstdlib>
int main(int argc, char** argv) {
    FILE* f = fopen("data.txt", "r");
    char buf[256] = {0};
    if (f) { if (!fgets(buf, sizeof buf, f)) buf[0] = 0; fclose(f); }
    printf("READ:%s\n", buf);
    if (argc > 1 && argv[1][0] == 's') std::this_thread::sleep_for(std::chrono::seconds(5));
    return 0;
}
EOF
g++ -std=c++17 -o prog prog.cpp -pthread || { echo "g++ 编译测试程序失败"; exit 1; }
g++ -std=c++17 -w -o helper "$SRC" || { echo "g++ 编译 helper 失败"; exit 1; }

reset_work() {
    rm -rf "$WORK/wd"
    mkdir -p "$WORK/wd"
    printf 'ORIGINAL\n' > "$WORK/wd/data.txt"
    printf 'ORIGINAL\n' > "$WORK/data_abs.txt"
}

# 1) 直跑 + 相对路径：程序应读到 stdin 内容，结束后还原原文件，无备份残留
reset_work
out=$(printf 'STDIN-DATA\n' | ./helper "$WORK/prog" data.txt out.txt "$WORK/wd" 1 2>&1)
if echo "$out" | grep -q 'READ:STDIN-DATA' \
   && [ "$(cat "$WORK/wd/data.txt")" = 'ORIGINAL' ] \
   && ! ls "$WORK/wd" | grep -q 'dream_bak'; then
    ok "直跑相对路径：程序读到 stdin，退出后原文件还原、无备份残留"
else
    bad "直跑相对路径" "out=[$out] data=[$(cat "$WORK/wd/data.txt")] 残留=[$(ls "$WORK/wd" | tr '\n' ' ')]"
fi

# 2) 被 Ctrl+C（SIGINT）打断：原文件仍须还原
reset_work
( sleep 1.2; pkill -INT -x helper 2>/dev/null ) &
printf 'STDIN-DATA\n' | ./helper "$WORK/prog" data.txt out.txt "$WORK/wd" 1 s >/dev/null 2>&1
wait 2>/dev/null
if [ "$(cat "$WORK/wd/data.txt")" = 'ORIGINAL' ] && ! ls "$WORK/wd" | grep -q 'dream_bak'; then
    ok "SIGINT 打断后原文件还原、无 .dream_bak 残留"
else
    bad "SIGINT 还原" "data=[$(cat "$WORK/wd/data.txt")] 残留=[$(ls "$WORK/wd" | tr '\n' ' ')]"
fi

# 3) 被 SIGTERM 打断：同样要还原
reset_work
( sleep 1.2; pkill -TERM -x helper 2>/dev/null ) &
printf 'STDIN-DATA\n' | ./helper "$WORK/prog" data.txt out.txt "$WORK/wd" 1 s >/dev/null 2>&1
wait 2>/dev/null
if [ "$(cat "$WORK/wd/data.txt")" = 'ORIGINAL' ] && ! ls "$WORK/wd" | grep -q 'dream_bak'; then
    ok "SIGTERM 打断后原文件还原、无 .dream_bak 残留"
else
    bad "SIGTERM 还原" "data=[$(cat "$WORK/wd/data.txt")] 残留=[$(ls "$WORK/wd" | tr '\n' ' ')]"
fi

# 4) 传绝对路径时不能再拼出 workDir/绝对路径 这种鬼路径
reset_work
printf 'STDIN-DATA\n' | ./helper "$WORK/prog" "$WORK/data_abs.txt" out.txt "$WORK/wd" 1 >/dev/null 2>&1
if [ "$(cat "$WORK/data_abs.txt")" = 'ORIGINAL' ] \
   && ! find "$WORK/wd" -maxdepth 1 -mindepth 1 -type d | grep -q . ; then
    ok "绝对路径不再被拼到 workDir 后面（无嵌套鬼目录）"
else
    bad "绝对路径处理" "data_abs=[$(cat "$WORK/data_abs.txt")] wd=[$(ls "$WORK/wd" | tr '\n' ' ')]"
fi

# 5) 镜像模式：.git 之类的巨目录不拷贝，程序自己写的文件不留在用户目录
reset_work
mkdir -p "$WORK/wd/.git/objects" && head -c 2048 /dev/urandom > "$WORK/wd/.git/objects/blob"
out=$(printf 'STDIN-DATA\n' | ./helper "$WORK/prog" data.txt out.txt "$WORK/wd" 0 2>&1)
if echo "$out" | grep -q 'READ:STDIN-DATA' && [ "$(cat "$WORK/wd/data.txt")" = 'ORIGINAL' ]; then
    ok "镜像模式：程序读到 stdin，用户目录未被改动"
else
    bad "镜像模式" "out=[$out] data=[$(cat "$WORK/wd/data.txt")]"
fi

echo
echo "helper-workdir: $pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
