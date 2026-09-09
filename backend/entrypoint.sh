#!/bin/sh
# Fly Volumeのマウント先(/data、参照ドキュメントの保存先)は、Fly側でマウントされた時点では
# root所有のまま渡ってくるため、非rootユーザー(appuser)では書き込めない。このため、
# Dockerfile側はUSER appuserを指定せずコンテナをrootのまま起動し、この entrypoint.sh が
# 起動直後に/dataの所有権をappuserへ変更してから、実際のアプリ本体プロセスはsuでappuserへ
# 権限を落として実行する(root権限で常駐させ続けない。DockerfileのUSER指定を使わない代わりに、
# 一般的な「rootで起動→権限修正→非rootへdrop」パターンを踏襲)。
#
# ${PORT:-8000}の展開はここ(POSIX shのパラメータ展開)で行う。CMD側で"sh -c ..."のように
# 引数を経由させると、suへ渡す際にクォートが失われて壊れるため、起動コマンド自体をこの
# スクリプト内に直接書き、単一の文字列としてsu -cへ渡す。
set -e

if [ -d /data ]; then
    chown -R appuser:appuser /data
fi

exec su appuser -c "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"
