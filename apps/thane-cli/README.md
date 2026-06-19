# Thane Chat CLI

Terminal-native team chat for Thane workspaces.

```bash
npm install -g @ask-thane/thane-cli
thane init
thane chat general
```

Check for updates:

```bash
thane update
```

Change your display name:

```bash
thane profile name "Garrett Petersen"
```

Customize the workspace art shown above the channel list:

```bash
thane workspace art set --file ./workspace-art.txt
printf 'ACME\n====' | thane workspace art set --stdin
thane workspace art reset
```

To migrate from Slack:

```bash
thane workspace create-from-slack ./slack-export.zip --apply
```

To invite a teammate:

```bash
thane invite-link create --expires 7d
thane invite-link accept https://api.askthane.com/invite/...
thane invite-link accept https://chat.askthane.com/invite/...
```
