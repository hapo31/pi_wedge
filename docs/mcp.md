# MCP接続

`pi_wedge` は Raspberry Pi 上で STL/STEP を A1 mini 向けにスライスし、完了結果をUUID付きのブラウザプレビューで利用者と確認するサービスです。MCPはモデルにこの役割と利用手順を伝えます。アップロード、スライス、印刷をMCPツールが実行する構成ではありません。

## 接続手順

1. pi_wedgeサーバーを起動し、MCPクライアントの実行環境からLANアドレスを確認します。例: `http://raspberrypi.local:3000`。
2. MCPクライアントで新しいリモートMCPサーバーを追加します。
3. トランスポートに Streamable HTTP、URLに `http://raspberrypi.local:3000/mcp` を指定します。`raspberrypi.local` はサーバーの実際のホスト名またはLAN IPに置き換えます。
4. HTTPヘッダー `Authorization: Bearer <API_TOKEN>` を設定し、接続します。値はサーバー管理者が `.env` に設定した `API_TOKEN` です。URLやツール引数には入れません。
5. クライアントのツール一覧に `pi_wedge_workflow` が表示されることを確認します。

クライアントによって設定画面やリモートHTTPサーバーの登録方法は異なります。サーバーURL、Streamable HTTP、Bearerヘッダーの3項目を指定してください。MCPクライアントとpi_wedgeサーバーの両方が同じLANから相互接続できる必要があります。

## モデルとの利用

ツールは、モデル作成後にどのAPIを使うか、スライス完了後に利用者とどのURLで形状を確認するかを返します。AI側は `/docs` または `/openapi.json` でAPI仕様を読み、認証済みHTTP APIでアップロードとスライスを行います。ジョブが `succeeded` になったら、`resultFileId` を使った `http://raspberrypi.local:3000/preview/{resultFileId}` を利用者に渡します。利用者はブラウザで3D表示を確認できます。

このMCPツールは静的な案内です。ファイル一覧・設定・モデル本体を読まず、スライスも印刷も行いません。印刷操作を追加する場合は、明示的なユーザー指示と既存APIの確認・冪等性要件を別途扱う必要があります。

## 接続確認

認証情報は出力せず、サーバーへMCP初期化リクエストを送って確認します。

```bash
curl -i http://raspberrypi.local:3000/mcp \
  -H 'Authorization: Bearer <API_TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual-check","version":"1.0"}}}'
```

レスポンスのJSON-RPC `result.serverInfo.name` が `pi_wedge` で、`result.capabilities.tools` が含まれていれば接続できています。MCPクライアントから `tools/list` を呼び、`pi_wedge_workflow` が表示されることも確認できます。トークンなしまたは誤ったトークンは401になります。

利用者向けプレビューはLAN内でトークン不要です。MCP接続情報に `API_TOKEN` を公開したり、会話やプレビューURLへ含めたりしないでください。
