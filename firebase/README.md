# Firebase Config

このディレクトリには Firebase 関連設定を配置します。

- `firestore.rules`: SPEC §8.2 に沿った Firestore security rules
- `firestore.indexes.json`: SPEC §10.1 の複合インデックス定義
- `storage.rules`: Storage バケットのアクセス制御
- `firebase.json`: Emulator と deploy 設定

## ローカル開発

```bash
firebase emulators:start --config firebase/firebase.json
```

利用ポート:

- Auth: `9099`
- Firestore: `8088`
- Storage: `9199`
- Functions: `5001`
- Emulator UI: `4000`

## デプロイ

```bash
firebase deploy --config firebase/firebase.json --only firestore:rules,firestore:indexes,storage
```

運用方針は `docs/SPEC.md` と `docs/PROMPT.md` に従います。
