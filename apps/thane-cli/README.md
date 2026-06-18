# Thane Chat CLI

Terminal-native team chat for Thane workspaces.

```bash
npm install -g @ask-thane/thane-cli
thane init
thane chat general
```

To migrate from Slack:

```bash
thane workspace create-from-slack ./slack-export.zip --apply
```

To invite a teammate:

```bash
thane invite-link create --expires 7d
thane invite-link accept https://api.askthane.com/invite/...
```
