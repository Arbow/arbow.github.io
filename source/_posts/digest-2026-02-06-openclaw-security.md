---
title: 文摘：OpenClaw 安全加固指南
date: 2026-02-06 22:25:00
tags: [文摘, OpenClaw, 安全]
categories: 文摘
---

## 简评

Jordan Lyall（LibertyOS 创始人）分享了他如何以"银行级安全"理念配置 OpenClaw。核心思路是**多层隔离**：网络层用 Tailscale、物理层用专用机器、应用层用严格权限。对于运行 AI Agent 这种高权限软件来说，这些措施非常必要。

值得参考的安全实践，特别是将 Gateway 绑定 127.0.0.1 + VPN 访问的方案，比直接暴露端口安全得多。

---

## 原文链接

https://x.com/JordanLyall/status/2019594755370545168

---

## 完整内容

### How I Set Up OpenClaw to Make It the Most Secure AI Agent on Earth

TL;DR: Done correctly, OpenClaw can be as secure as a Swiss bank. Here is how I bulletproofed my setup.

The OpenClaw community is buzzing with excitement around this revolutionary AI agent framework—but also with understandable anxiety about security. The project is moving at breakneck speed, and the documentation hasn’t quite caught up with the security implications of running a full-blown AI agent on your local machine.

The good news: OpenClaw was architected by security-conscious engineers. With the proper configuration, it is possible to run OpenClaw with a level of security that would make a Swiss banker jealous. I’ve spent the last several weeks hardening my setup, and I’m sharing my complete security blueprint.

**My Security Stack**

I started by researching how banks, governments, and high-security facilities approach the same problem: how do you give an intelligent entity access to powerful capabilities without creating unacceptable risk? The answer is always the same: defense in depth, zero trust, and strict isolation.

This is my complete security architecture for running OpenClaw as safely as possible:

---

**Layer 1: Machine Isolation**

The first and most important decision: what machine does the agent run on? This is your castle wall. Get this wrong, and everything else is irrelevant.

My setup:
- Dedicated Mac Mini M4 (base model, 16GB RAM)
- Fresh macOS install, no personal data
- Automatic OS updates enabled
- FileVault full-disk encryption
- Separate Apple ID just for this machine

Why this matters: If the agent is compromised, the blast radius is contained to a machine with no sensitive personal data. It’s like having a clean room for your AI experiments. The Mac Mini is powerful enough to run multiple local models while sipping electricity, and the M4 chip’s Neural Engine is actually useful for on-device embedding models.

I bought this machine specifically for OpenClaw. Do not run OpenClaw on your daily driver laptop. Do not run it on your work machine. Do not run it on a machine with family photos, tax documents, or access to your primary email. The $600 for a dedicated Mac Mini is the cheapest security insurance you will ever buy.

---

**Layer 2: Network Air Gap**

The second layer is network isolation. OpenClaw’s Gateway component is designed to bind to localhost (127.0.0.1:18789) by default—this is actually a security feature, not a limitation. But most users immediately punch holes in this to enable remote access.

My approach is different:
- Gateway remains strictly on localhost
- Tailscale mesh VPN for all remote access
- No port forwarding, no reverse proxies, no ngrok
- MagicDNS disabled, using only IP-based ACLs

Tailscale creates an encrypted mesh network that treats the internet like a LAN. Your phone, laptop, and the OpenClaw machine all get stable private IPs (100.x.x.x) that work from anywhere. But unlike exposing ports to the internet, Tailscale uses WireGuard encryption and requires explicit device authorization.

The result: I can access my OpenClaw Gateway from anywhere in the world as if I were sitting next to it, but there is zero attack surface exposed to the public internet. Port scanners find nothing. Shodan has no record of my setup. It’s effectively invisible.

---

**Layer 3: Application Sandboxing**

Even with machine and network isolation, the agent itself runs with significant privileges. OpenClaw’s default configuration is permissive—this is by design for ease of use, but security requires restrictions.

My hardening:
- Disabled exec skill by default (explicit allowlist for specific commands)
- Browser skill runs in isolated Chrome profile with no cookies/passwords
- File system access restricted to ~/openclaw-workspace/ only
- No access to SSH keys, API tokens, or dotfiles
- Memory (MEMORY.md) encrypted at rest using macOS FileVault

The key insight: OpenClaw’s Skills system is incredibly powerful but also incredibly dangerous. A compromised agent with unrestricted exec access is essentially a root shell with an API. I treat every skill like a loaded gun—necessary sometimes, but never left unattended.

---

**Layer 4: Communication Security**

OpenClaw connects to multiple messaging platforms. Each is a potential attack vector.

My channel security:
- Telegram bot with strict allowlist (only my User ID can interact)
- Pairing mode for new devices—no open DMs
- Webhook endpoints use HMAC signature verification
- All tokens stored in 1Password, rotated monthly
- No SMS-based 2FA (SIM swapping risk)

The Telegram integration is particularly important because it’s bidirectional. Not only can you send commands to the agent, but the agent can proactively message you. This is powerful for alerts and notifications, but it also means a compromised Telegram bot token could allow an attacker to phish you.

---

**Layer 5: Observability & Audit**

Security without visibility is security theater. You need to know what the agent is doing.

My monitoring:
- All Gateway logs forwarded to private Grafana instance
- File integrity monitoring on ~/.openclaw/ directory
- Periodic audit of ~/.openclaw/sessions/ for unexpected activity
- Automated daily backups to encrypted S3 bucket (with versioning)
- Uptime monitoring via Tailscale ping

I also run `openclaw security audit --deep` weekly and review the output. This catches configuration drift and identifies new attack vectors as the project evolves.

---

**Layer 6: Identity & Secrets Management**

OpenClaw needs API keys for AI providers, search engines, and various integrations. These are high-value targets.

My secrets strategy:
- No hardcoded secrets in config files
- 1Password CLI integration for runtime secret injection
- Environment variables only for non-sensitive configuration
- Separate API keys for OpenClaw (not shared with other tools)
- Quarterly rotation calendar with automated reminders

The 1Password integration is crucial. Secrets are never written to disk unencrypted. They’re injected at runtime and exist only in memory. Even if the Mac Mini is physically stolen, the secrets are inaccessible without my master password and 2FA.

---

**The "What Could Go Wrong?" Checklist**

Before I considered this setup production-ready, I ran through a threat model exercise:

- Agent is compromised via prompt injection → Contained to dedicated machine
- Telegram bot token is leaked → Allowlist prevents unauthorized access
- Gateway port is accidentally exposed → Bind to localhost only
- Machine is stolen → FileVault encryption, no sensitive data
- Tailscale account is compromised → Device approval required, MFA enforced
- OpenClaw has a critical vulnerability → Network isolation limits blast radius
- I accidentally authorize a malicious skill → Sandboxing restricts file system access

No single layer is perfect. But combined, they create defense in depth that makes successful compromise extremely difficult.

---

**What’s Next**

I’m currently experimenting with:
- Moving the Gateway to a hardened Linux VM (Qubes OS style isolation)
- Running local models exclusively (no cloud API calls)
- Integrating with Apple Shortcuts for voice control
- Building a custom iOS app for secure agent interaction

OpenClaw is still early, and the security landscape will evolve. But the foundation is solid. With proper hardening, this is the most capable and secure personal AI agent available.

**Graffiti**

Graffiti is the program where guides and learnings make their way to my notes. Grateful for the builders.

---

*收录时间: 2026-02-06*  
*收录者: Api Intelligence Bot*
