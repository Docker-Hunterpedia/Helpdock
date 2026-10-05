# Design screens

A rendered snapshot of every artboard on the Helpdock design canvas, so contributors can see how each screen should look without opening the canvas.

- **Canvas, the source of truth:** https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ (private until shared). When the canvas and this folder disagree, the canvas wins.
- **Design system:** [DESIGN.md](../../DESIGN.md) defines the tokens, components, RTL rules and the accessibility checklist every screen is built from.
- **Design-first rule:** every screen, dialog, widget mode, help center page and email template is drawn as an artboard before it is built, and an implementation PR names the artboard it was built from. See [AGENTS.md](../../AGENTS.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md).

## What is here

| Path | Contents |
|---|---|
| [`artboards/`](artboards/) | The source of each artboard (`*.dc.html`) and `canvas.json`, the canvas manifest with every board's title, size and position. Diff these in a PR to review a design change. |
| [`screens/`](screens/) | One PNG per artboard at its canvas size, grouped by the canvas section it sits under: `foundations`, `applications`, then `m0` to `m8`. |

The artboards are static mockups. Names, numbers, domains and size caps on them are sample values; behaviour comes from [DOMAIN-RULES.md](../planning/DOMAIN-RULES.md).

## Re-rendering

When an artboard changes, export its `*.dc.html` and `canvas.json` from the canvas into `artboards/`, then run:

```sh
pnpm design:render
```

This runs [`scripts/render-artboards.ts`](../../scripts/render-artboards.ts) with Playwright's Chromium. For each board in `canvas.json` it drops the canvas runtime, fills the `{{…}}` holes from the artboard's own values and default props (the brand `accent` renders as the default teal), replaces the Google Fonts link with the IBM Plex files self-hosted in `packages/ui/fonts`, and screenshots the board at its canvas size. It deletes and rewrites `screens/`, so a removed board loses its PNG too. If Playwright's own Chromium is not installed, set `CHROMIUM_EXECUTABLE` to the path of a Chromium binary. Update the index below by hand when a board is added, renamed or removed.

## Index

Each row links the rendered screen and its source. Deliverable ids refer to the [PRD](../planning/PRD.md); foundations boards refer to sections of DESIGN.md.


### Foundations

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `01 Color` | DESIGN §2 | [01-Color.png](screens/foundations/01-Color.png) | [Main.dc.html](artboards/Main.dc.html) |
| `02 Typography` | DESIGN §3 | [02-Typography.png](screens/foundations/02-Typography.png) | [Typography.dc.html](artboards/Typography.dc.html) |
| `03 Components` | DESIGN §6 | [03-Components.png](screens/foundations/03-Components.png) | [Components.dc.html](artboards/Components.dc.html) |

### Applications (first reference screens)

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `Admin · ticket view` | M1-02, M1-03, M1-15 | [Admin-ticket-view.png](screens/applications/Admin-ticket-view.png) | [AdminTicket.dc.html](artboards/AdminTicket.dc.html) |
| `Widget · EN` | M4-01, M4-06 | [Widget-EN.png](screens/applications/Widget-EN.png) | [WidgetEN.dc.html](artboards/WidgetEN.dc.html) |
| `Widget · AR (RTL)` | M4-01, M4-06 | [Widget-AR-RTL.png](screens/applications/Widget-AR-RTL.png) | [WidgetAR.dc.html](artboards/WidgetAR.dc.html) |
| `Help center · article` | M5-03 | [Help-center-article.png](screens/applications/Help-center-article.png) | [HelpCenter.dc.html](artboards/HelpCenter.dc.html) |

### M0 Skeleton

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `Admin/Login` | M0-05, M0-07 | [Admin-Login.png](screens/m0/Admin-Login.png) | [AdminLogin.dc.html](artboards/AdminLogin.dc.html) |
| `Admin/Login-AR` | M0-05, M0-07 | [Admin-Login-AR.png](screens/m0/Admin-Login-AR.png) | [AdminLoginAR.dc.html](artboards/AdminLoginAR.dc.html) |
| `Admin/TOTP` | M0-05 | [Admin-TOTP.png](screens/m0/Admin-TOTP.png) | [AdminTotp.dc.html](artboards/AdminTotp.dc.html) |
| `Admin/Wizard` | M0-08 | [Admin-Wizard.png](screens/m0/Admin-Wizard.png) | [AdminWizard.dc.html](artboards/AdminWizard.dc.html) |
| `Admin/Settings` | M0-02 | [Admin-Settings.png](screens/m0/Admin-Settings.png) | [AdminSettings.dc.html](artboards/AdminSettings.dc.html) |
| `Admin/Staff` | M0-06 | [Admin-Staff.png](screens/m0/Admin-Staff.png) | [AdminStaff.dc.html](artboards/AdminStaff.dc.html) |
| `Admin/System` | M0-10 | [Admin-System.png](screens/m0/Admin-System.png) | [AdminSystem.dc.html](artboards/AdminSystem.dc.html) |
| `Admin/Enrol2FA` | M0-05 | [Admin-Enrol2FA.png](screens/m0/Admin-Enrol2FA.png) | [AdminEnrol2FA.dc.html](artboards/AdminEnrol2FA.dc.html) |
| `Admin/AcceptInvite` | M0-06 | [Admin-AcceptInvite.png](screens/m0/Admin-AcceptInvite.png) | [AdminAcceptInvite.dc.html](artboards/AdminAcceptInvite.dc.html) |
| `Admin/Wizard-SetupKey` | M0-08 | [Admin-Wizard-SetupKey.png](screens/m0/Admin-Wizard-SetupKey.png) | [AdminWizardSetupKey.dc.html](artboards/AdminWizardSetupKey.dc.html) |

### M1 Ticketing core

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `Admin/Contacts` | M1-04 | [Admin-Contacts.png](screens/m1/Admin-Contacts.png) | [AdminContacts.dc.html](artboards/AdminContacts.dc.html) |
| `Admin/Contact` | M1-04, M1-13 | [Admin-Contact.png](screens/m1/Admin-Contact.png) | [AdminContact.dc.html](artboards/AdminContact.dc.html) |
| `Admin/Ticketing` | M1-01, M1-08 | [Admin-Ticketing.png](screens/m1/Admin-Ticketing.png) | [AdminTicketing.dc.html](artboards/AdminTicketing.dc.html) |
| `Admin/Brand` | M1-01 | [Admin-Brand.png](screens/m1/Admin-Brand.png) | [AdminBrand.dc.html](artboards/AdminBrand.dc.html) |
| `Public/CSAT-EN` | M1-12 | [Public-CSAT-EN.png](screens/m1/Public-CSAT-EN.png) | [CsatEN.dc.html](artboards/CsatEN.dc.html) |
| `Public/CSAT-AR` | M1-12 | [Public-CSAT-AR.png](screens/m1/Public-CSAT-AR.png) | [CsatAR.dc.html](artboards/CsatAR.dc.html) |
| `Admin/Brand-Danger` | M1-14, M8-07 | [Admin-Brand-Danger.png](screens/m1/Admin-Brand-Danger.png) | [AdminBrandDanger.dc.html](artboards/AdminBrandDanger.dc.html) |
| `Admin/Ticketing-Assignment` | M1-07 | [Admin-Ticketing-Assignment.png](screens/m1/Admin-Ticketing-Assignment.png) | [AdminTicketingAssignment.dc.html](artboards/AdminTicketingAssignment.dc.html) |
| `Admin/Ticketing-Spam` | M1-11 | [Admin-Ticketing-Spam.png](screens/m1/Admin-Ticketing-Spam.png) | [AdminTicketingSpam.dc.html](artboards/AdminTicketingSpam.dc.html) |
| `Admin/Ticketing-Feedback` | M1-12 | [Admin-Ticketing-Feedback.png](screens/m1/Admin-Ticketing-Feedback.png) | [AdminTicketingFeedback.dc.html](artboards/AdminTicketingFeedback.dc.html) |
| `Admin/Ticket-Dialogs` | M1-09, M1-15 | [Admin-Ticket-Dialogs.png](screens/m1/Admin-Ticket-Dialogs.png) | [AdminTicketDialogs.dc.html](artboards/AdminTicketDialogs.dc.html) |
| `Admin/Contact-Dialogs` | M1-13 | [Admin-Contact-Dialogs.png](screens/m1/Admin-Contact-Dialogs.png) | [AdminContactDialogs.dc.html](artboards/AdminContactDialogs.dc.html) |
| `Admin/Ticketing-Views` | M1-05 | [Admin-Ticketing-Views.png](screens/m1/Admin-Ticketing-Views.png) | [AdminTicketingViews.dc.html](artboards/AdminTicketingViews.dc.html) |
| `Admin/View-Dialogs` | M1-05 | [Admin-View-Dialogs.png](screens/m1/Admin-View-Dialogs.png) | [AdminViewDialogs.dc.html](artboards/AdminViewDialogs.dc.html) |
| `Admin/Ticket-Tags` | M1-06, M1-15 | [Admin-Ticket-Tags.png](screens/m1/Admin-Ticket-Tags.png) | [AdminTicketTags.dc.html](artboards/AdminTicketTags.dc.html) |

### M2 Email channel

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `Admin/Email` | M2-08 | [Admin-Email.png](screens/m2/Admin-Email.png) | [AdminEmail.dc.html](artboards/AdminEmail.dc.html) |
| `Admin/Email-Outgoing` | M2-05, M2-06 | [Admin-Email-Outgoing.png](screens/m2/Admin-Email-Outgoing.png) | [AdminEmailOutgoing.dc.html](artboards/AdminEmailOutgoing.dc.html) |
| `Admin/Email-Mailbox` | M2-02, M2-03, M2-08 | [Admin-Email-Mailbox.png](screens/m2/Admin-Email-Mailbox.png) | [AdminEmailMailbox.dc.html](artboards/AdminEmailMailbox.dc.html) |
| `Admin/Ticket-Email` | M2-04, M2-07 | [Admin-Ticket-Email.png](screens/m2/Admin-Ticket-Email.png) | [AdminTicketEmail.dc.html](artboards/AdminTicketEmail.dc.html) |
| `Email/Customer-EN-AR` | M2-05, M2-06 | [Email-Customer-EN-AR.png](screens/m2/Email-Customer-EN-AR.png) | [EmailCustomer.dc.html](artboards/EmailCustomer.dc.html) |
| `Admin/Profile-Signature` | M2-05 | [Admin-Profile-Signature.png](screens/m2/Admin-Profile-Signature.png) | [AdminSignature.dc.html](artboards/AdminSignature.dc.html) |

### M3 Automation and SLAs

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `Admin/Ticketing-BusinessHours` | M3-01 | [Admin-Ticketing-BusinessHours.png](screens/m3/Admin-Ticketing-BusinessHours.png) | [AdminTicketingBusinessHours.dc.html](artboards/AdminTicketingBusinessHours.dc.html) |
| `Admin/Ticketing-SLAs` | M3-02 | [Admin-Ticketing-SLAs.png](screens/m3/Admin-Ticketing-SLAs.png) | [AdminTicketingSLAs.dc.html](artboards/AdminTicketingSLAs.dc.html) |
| `Admin/Ticket-SLA` | M3-02 | [Admin-Ticket-SLA.png](screens/m3/Admin-Ticket-SLA.png) | [AdminTicketSLA.dc.html](artboards/AdminTicketSLA.dc.html) |
| `Admin/Automation-Rules` | M3-03, M3-04 | [Admin-Automation-Rules.png](screens/m3/Admin-Automation-Rules.png) | [AdminAutomationRules.dc.html](artboards/AdminAutomationRules.dc.html) |
| `Admin/Rule-Builder` | M3-05 | [Admin-Rule-Builder.png](screens/m3/Admin-Rule-Builder.png) | [AdminRuleBuilder.dc.html](artboards/AdminRuleBuilder.dc.html) |
| `Admin/Automation-Macros` | M3-06 | [Admin-Automation-Macros.png](screens/m3/Admin-Automation-Macros.png) | [AdminAutomationMacros.dc.html](artboards/AdminAutomationMacros.dc.html) |
| `Admin/Composer-Macros` | M3-06 | [Admin-Composer-Macros.png](screens/m3/Admin-Composer-Macros.png) | [AdminComposerMacros.dc.html](artboards/AdminComposerMacros.dc.html) |
| `Admin/Notifications` | M3-07 | [Admin-Notifications.png](screens/m3/Admin-Notifications.png) | [AdminNotifications.dc.html](artboards/AdminNotifications.dc.html) |
| `Email/Staff-Notification` | M3-07 | [Email-Staff-Notification.png](screens/m3/Email-Staff-Notification.png) | [EmailStaffNotification.dc.html](artboards/EmailStaffNotification.dc.html) |
| `Admin/Audit-Log` | M3-08 | [Admin-Audit-Log.png](screens/m3/Admin-Audit-Log.png) | [AdminAuditLog.dc.html](artboards/AdminAuditLog.dc.html) |

### M4 Widget and realtime

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `Widget/States-EN` | M4-03, M4-04, M4-07, M4-08, M4-11 | [Widget-States-EN.png](screens/m4/Widget-States-EN.png) | [WidgetStatesEN.dc.html](artboards/WidgetStatesEN.dc.html) |
| `Widget/States-AR` | M4-03, M4-04, M4-07, M4-08, M4-11 | [Widget-States-AR.png](screens/m4/Widget-States-AR.png) | [WidgetStatesAR.dc.html](artboards/WidgetStatesAR.dc.html) |
| `Widget/Modes-EN` | M4-05, M4-06, M5-10 | [Widget-Modes-EN.png](screens/m4/Widget-Modes-EN.png) | [WidgetModesEN.dc.html](artboards/WidgetModesEN.dc.html) |
| `Widget/Modes-AR` | M4-05, M4-06, M5-10 | [Widget-Modes-AR.png](screens/m4/Widget-Modes-AR.png) | [WidgetModesAR.dc.html](artboards/WidgetModesAR.dc.html) |
| `Public/WebForm-EN` | M4-09 | [Public-WebForm-EN.png](screens/m4/Public-WebForm-EN.png) | [WebFormEN.dc.html](artboards/WebFormEN.dc.html) |
| `Public/WebForm-AR` | M4-09 | [Public-WebForm-AR.png](screens/m4/Public-WebForm-AR.png) | [WebFormAR.dc.html](artboards/WebFormAR.dc.html) |
| `Admin/Channels-Widget` | M4-03, M4-06, M4-07, M4-08 | [Admin-Channels-Widget.png](screens/m4/Admin-Channels-Widget.png) | [AdminWidget.dc.html](artboards/AdminWidget.dc.html) |
| `Admin/Channels-WebForm` | M4-09 | [Admin-Channels-WebForm.png](screens/m4/Admin-Channels-WebForm.png) | [AdminWebForm.dc.html](artboards/AdminWebForm.dc.html) |

### M5 Help center

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `HelpCenter/Home-EN` | M5-03, M5-06 | [HelpCenter-Home-EN.png](screens/m5/HelpCenter-Home-EN.png) | [HelpCenterHomeEN.dc.html](artboards/HelpCenterHomeEN.dc.html) |
| `HelpCenter/Home-AR` | M5-03, M5-06 | [HelpCenter-Home-AR.png](screens/m5/HelpCenter-Home-AR.png) | [HelpCenterHomeAR.dc.html](artboards/HelpCenterHomeAR.dc.html) |
| `HelpCenter/Category-EN` | M5-01, M5-03 | [HelpCenter-Category-EN.png](screens/m5/HelpCenter-Category-EN.png) | [HelpCenterCategoryEN.dc.html](artboards/HelpCenterCategoryEN.dc.html) |
| `HelpCenter/Category-AR` | M5-01, M5-03 | [HelpCenter-Category-AR.png](screens/m5/HelpCenter-Category-AR.png) | [HelpCenterCategoryAR.dc.html](artboards/HelpCenterCategoryAR.dc.html) |
| `HelpCenter/Article-AR` | M5-03, M5-08 | [HelpCenter-Article-AR.png](screens/m5/HelpCenter-Article-AR.png) | [HelpCenterArticleAR.dc.html](artboards/HelpCenterArticleAR.dc.html) |
| `HelpCenter/Search-EN` | M5-05 | [HelpCenter-Search-EN.png](screens/m5/HelpCenter-Search-EN.png) | [HelpCenterSearchEN.dc.html](artboards/HelpCenterSearchEN.dc.html) |
| `HelpCenter/Search-AR` | M5-05 | [HelpCenter-Search-AR.png](screens/m5/HelpCenter-Search-AR.png) | [HelpCenterSearchAR.dc.html](artboards/HelpCenterSearchAR.dc.html) |
| `HelpCenter/States-EN` | M5-03, M5-09 | [HelpCenter-States-EN.png](screens/m5/HelpCenter-States-EN.png) | [HelpCenterStatesEN.dc.html](artboards/HelpCenterStatesEN.dc.html) |
| `Admin/HelpCenter` | M5-01, M5-09 | [Admin-HelpCenter.png](screens/m5/Admin-HelpCenter.png) | [AdminHelpCenter.dc.html](artboards/AdminHelpCenter.dc.html) |
| `Admin/HelpCenter-Editor` | M5-02 | [Admin-HelpCenter-Editor.png](screens/m5/Admin-HelpCenter-Editor.png) | [AdminArticleEditor.dc.html](artboards/AdminArticleEditor.dc.html) |
| `Admin/HelpCenter-Settings` | M5-06, M5-09 | [Admin-HelpCenter-Settings.png](screens/m5/Admin-HelpCenter-Settings.png) | [AdminHelpCenterSettings.dc.html](artboards/AdminHelpCenterSettings.dc.html) |
| `Admin/Brand-Domains` | M5-07 | [Admin-Brand-Domains.png](screens/m5/Admin-Brand-Domains.png) | [AdminBrandDomains.dc.html](artboards/AdminBrandDomains.dc.html) |

### M6 Telegram

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `Admin/Channels-Telegram` | M6-01, M6-05 | [Admin-Channels-Telegram.png](screens/m6/Admin-Channels-Telegram.png) | [AdminChannelsTelegram.dc.html](artboards/AdminChannelsTelegram.dc.html) |
| `Admin/Ticket-Telegram` | M6-02, M6-03 | [Admin-Ticket-Telegram.png](screens/m6/Admin-Ticket-Telegram.png) | [AdminTicketTelegram.dc.html](artboards/AdminTicketTelegram.dc.html) |
| `Telegram/Chat-EN` | M6-02, M6-03, M6-04 | [Telegram-Chat-EN.png](screens/m6/Telegram-Chat-EN.png) | [TelegramChatEN.dc.html](artboards/TelegramChatEN.dc.html) |
| `Telegram/Chat-AR` | M6-02, M6-03, M6-04 | [Telegram-Chat-AR.png](screens/m6/Telegram-Chat-AR.png) | [TelegramChatAR.dc.html](artboards/TelegramChatAR.dc.html) |

### M7 AI

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `Admin/AI-Providers` | M7-01, M7-02, M7-10 | [Admin-AI-Providers.png](screens/m7/Admin-AI-Providers.png) | [AdminAIProviders.dc.html](artboards/AdminAIProviders.dc.html) |
| `Admin/AI-Knowledge` | M7-03, M7-10 | [Admin-AI-Knowledge.png](screens/m7/Admin-AI-Knowledge.png) | [AdminAIKnowledge.dc.html](artboards/AdminAIKnowledge.dc.html) |
| `Admin/AI-Assistant` | M7-06, M7-08, M7-10 | [Admin-AI-Assistant.png](screens/m7/Admin-AI-Assistant.png) | [AdminAIAssistant.dc.html](artboards/AdminAIAssistant.dc.html) |
| `Admin/Wizard-AI` | M7-10 | [Admin-Wizard-AI.png](screens/m7/Admin-Wizard-AI.png) | [AdminWizardAI.dc.html](artboards/AdminWizardAI.dc.html) |
| `Admin/Ticket-AI` | M7-05, M7-09 | [Admin-Ticket-AI.png](screens/m7/Admin-Ticket-AI.png) | [AdminTicketAI.dc.html](artboards/AdminTicketAI.dc.html) |
| `Widget/AI-EN` | M7-04, M7-06 | [Widget-AI-EN.png](screens/m7/Widget-AI-EN.png) | [WidgetAIEN.dc.html](artboards/WidgetAIEN.dc.html) |
| `Widget/AI-AR` | M7-04, M7-06 | [Widget-AI-AR.png](screens/m7/Widget-AI-AR.png) | [WidgetAIAR.dc.html](artboards/WidgetAIAR.dc.html) |
| `Admin/HelpCenter-ArticleApproval` | M7-03 | [Admin-HelpCenter-ArticleApproval.png](screens/m7/Admin-HelpCenter-ArticleApproval.png) | [AdminArticleApproval.dc.html](artboards/AdminArticleApproval.dc.html) |

### M8 API, webhooks, reports

| Artboard | Deliverables | Screen | Source |
|---|---|---|---|
| `Admin/Developers-ApiKeys` | M8-01, M8-02 | [Admin-Developers-ApiKeys.png](screens/m8/Admin-Developers-ApiKeys.png) | [AdminDevelopersApiKeys.dc.html](artboards/AdminDevelopersApiKeys.dc.html) |
| `Admin/Developers-Webhooks` | M8-03 | [Admin-Developers-Webhooks.png](screens/m8/Admin-Developers-Webhooks.png) | [AdminDevelopersWebhooks.dc.html](artboards/AdminDevelopersWebhooks.dc.html) |
| `Admin/Reports` | M8-04 | [Admin-Reports.png](screens/m8/Admin-Reports.png) | [AdminReports.dc.html](artboards/AdminReports.dc.html) |
| `Admin/System-1.0` | M8-05 | [Admin-System-1.0.png](screens/m8/Admin-System-1.0.png) | [AdminSystemV1.dc.html](artboards/AdminSystemV1.dc.html) |
| `Email/CSAT-EN-AR` | M8-06 | [Email-CSAT-EN-AR.png](screens/m8/Email-CSAT-EN-AR.png) | [EmailCsat.dc.html](artboards/EmailCsat.dc.html) |
| `Widget/CSAT-EN` | M8-06 | [Widget-CSAT-EN.png](screens/m8/Widget-CSAT-EN.png) | [WidgetCsatEN.dc.html](artboards/WidgetCsatEN.dc.html) |
| `Widget/CSAT-AR` | M8-06 | [Widget-CSAT-AR.png](screens/m8/Widget-CSAT-AR.png) | [WidgetCsatAR.dc.html](artboards/WidgetCsatAR.dc.html) |

## Gallery

The same screens, inline. Large boards are shown at their full canvas size; open the image for detail.

### Foundations

#### `01 Color`

![01 Color](screens/foundations/01-Color.png)

#### `02 Typography`

![02 Typography](screens/foundations/02-Typography.png)

#### `03 Components`

![03 Components](screens/foundations/03-Components.png)


### Applications (first reference screens)

#### `Admin · ticket view`

![Admin · ticket view](screens/applications/Admin-ticket-view.png)

#### `Widget · EN`

![Widget · EN](screens/applications/Widget-EN.png)

#### `Widget · AR (RTL)`

![Widget · AR (RTL)](screens/applications/Widget-AR-RTL.png)

#### `Help center · article`

![Help center · article](screens/applications/Help-center-article.png)


### M0 Skeleton

#### `Admin/Login`

![Admin/Login](screens/m0/Admin-Login.png)

#### `Admin/Login-AR`

![Admin/Login-AR](screens/m0/Admin-Login-AR.png)

#### `Admin/TOTP`

![Admin/TOTP](screens/m0/Admin-TOTP.png)

#### `Admin/Wizard`

![Admin/Wizard](screens/m0/Admin-Wizard.png)

#### `Admin/Settings`

![Admin/Settings](screens/m0/Admin-Settings.png)

#### `Admin/Staff`

![Admin/Staff](screens/m0/Admin-Staff.png)

#### `Admin/System`

![Admin/System](screens/m0/Admin-System.png)

#### `Admin/Enrol2FA`

![Admin/Enrol2FA](screens/m0/Admin-Enrol2FA.png)

#### `Admin/AcceptInvite`

![Admin/AcceptInvite](screens/m0/Admin-AcceptInvite.png)

#### `Admin/Wizard-SetupKey`

![Admin/Wizard-SetupKey](screens/m0/Admin-Wizard-SetupKey.png)


### M1 Ticketing core

#### `Admin/Contacts`

![Admin/Contacts](screens/m1/Admin-Contacts.png)

#### `Admin/Contact`

![Admin/Contact](screens/m1/Admin-Contact.png)

#### `Admin/Ticketing`

![Admin/Ticketing](screens/m1/Admin-Ticketing.png)

#### `Admin/Brand`

![Admin/Brand](screens/m1/Admin-Brand.png)

#### `Public/CSAT-EN`

![Public/CSAT-EN](screens/m1/Public-CSAT-EN.png)

#### `Public/CSAT-AR`

![Public/CSAT-AR](screens/m1/Public-CSAT-AR.png)

#### `Admin/Brand-Danger`

![Admin/Brand-Danger](screens/m1/Admin-Brand-Danger.png)

#### `Admin/Ticketing-Assignment`

![Admin/Ticketing-Assignment](screens/m1/Admin-Ticketing-Assignment.png)

#### `Admin/Ticketing-Spam`

![Admin/Ticketing-Spam](screens/m1/Admin-Ticketing-Spam.png)

#### `Admin/Ticketing-Feedback`

![Admin/Ticketing-Feedback](screens/m1/Admin-Ticketing-Feedback.png)

#### `Admin/Ticket-Dialogs`

![Admin/Ticket-Dialogs](screens/m1/Admin-Ticket-Dialogs.png)

#### `Admin/Contact-Dialogs`

![Admin/Contact-Dialogs](screens/m1/Admin-Contact-Dialogs.png)

#### `Admin/Ticketing-Views`

![Admin/Ticketing-Views](screens/m1/Admin-Ticketing-Views.png)

#### `Admin/View-Dialogs`

![Admin/View-Dialogs](screens/m1/Admin-View-Dialogs.png)

#### `Admin/Ticket-Tags`

![Admin/Ticket-Tags](screens/m1/Admin-Ticket-Tags.png)


### M2 Email channel

#### `Admin/Email`

![Admin/Email](screens/m2/Admin-Email.png)

#### `Admin/Email-Outgoing`

![Admin/Email-Outgoing](screens/m2/Admin-Email-Outgoing.png)

#### `Admin/Email-Mailbox`

![Admin/Email-Mailbox](screens/m2/Admin-Email-Mailbox.png)

#### `Admin/Ticket-Email`

![Admin/Ticket-Email](screens/m2/Admin-Ticket-Email.png)

#### `Email/Customer-EN-AR`

![Email/Customer-EN-AR](screens/m2/Email-Customer-EN-AR.png)

#### `Admin/Profile-Signature`

![Admin/Profile-Signature](screens/m2/Admin-Profile-Signature.png)


### M3 Automation and SLAs

#### `Admin/Ticketing-BusinessHours`

![Admin/Ticketing-BusinessHours](screens/m3/Admin-Ticketing-BusinessHours.png)

#### `Admin/Ticketing-SLAs`

![Admin/Ticketing-SLAs](screens/m3/Admin-Ticketing-SLAs.png)

#### `Admin/Ticket-SLA`

![Admin/Ticket-SLA](screens/m3/Admin-Ticket-SLA.png)

#### `Admin/Automation-Rules`

![Admin/Automation-Rules](screens/m3/Admin-Automation-Rules.png)

#### `Admin/Rule-Builder`

![Admin/Rule-Builder](screens/m3/Admin-Rule-Builder.png)

#### `Admin/Automation-Macros`

![Admin/Automation-Macros](screens/m3/Admin-Automation-Macros.png)

#### `Admin/Composer-Macros`

![Admin/Composer-Macros](screens/m3/Admin-Composer-Macros.png)

#### `Admin/Notifications`

![Admin/Notifications](screens/m3/Admin-Notifications.png)

#### `Email/Staff-Notification`

![Email/Staff-Notification](screens/m3/Email-Staff-Notification.png)

#### `Admin/Audit-Log`

![Admin/Audit-Log](screens/m3/Admin-Audit-Log.png)


### M4 Widget and realtime

#### `Widget/States-EN`

![Widget/States-EN](screens/m4/Widget-States-EN.png)

#### `Widget/States-AR`

![Widget/States-AR](screens/m4/Widget-States-AR.png)

#### `Widget/Modes-EN`

![Widget/Modes-EN](screens/m4/Widget-Modes-EN.png)

#### `Widget/Modes-AR`

![Widget/Modes-AR](screens/m4/Widget-Modes-AR.png)

#### `Public/WebForm-EN`

![Public/WebForm-EN](screens/m4/Public-WebForm-EN.png)

#### `Public/WebForm-AR`

![Public/WebForm-AR](screens/m4/Public-WebForm-AR.png)

#### `Admin/Channels-Widget`

![Admin/Channels-Widget](screens/m4/Admin-Channels-Widget.png)

#### `Admin/Channels-WebForm`

![Admin/Channels-WebForm](screens/m4/Admin-Channels-WebForm.png)


### M5 Help center

#### `HelpCenter/Home-EN`

![HelpCenter/Home-EN](screens/m5/HelpCenter-Home-EN.png)

#### `HelpCenter/Home-AR`

![HelpCenter/Home-AR](screens/m5/HelpCenter-Home-AR.png)

#### `HelpCenter/Category-EN`

![HelpCenter/Category-EN](screens/m5/HelpCenter-Category-EN.png)

#### `HelpCenter/Category-AR`

![HelpCenter/Category-AR](screens/m5/HelpCenter-Category-AR.png)

#### `HelpCenter/Article-AR`

![HelpCenter/Article-AR](screens/m5/HelpCenter-Article-AR.png)

#### `HelpCenter/Search-EN`

![HelpCenter/Search-EN](screens/m5/HelpCenter-Search-EN.png)

#### `HelpCenter/Search-AR`

![HelpCenter/Search-AR](screens/m5/HelpCenter-Search-AR.png)

#### `HelpCenter/States-EN`

![HelpCenter/States-EN](screens/m5/HelpCenter-States-EN.png)

#### `Admin/HelpCenter`

![Admin/HelpCenter](screens/m5/Admin-HelpCenter.png)

#### `Admin/HelpCenter-Editor`

![Admin/HelpCenter-Editor](screens/m5/Admin-HelpCenter-Editor.png)

#### `Admin/HelpCenter-Settings`

![Admin/HelpCenter-Settings](screens/m5/Admin-HelpCenter-Settings.png)

#### `Admin/Brand-Domains`

![Admin/Brand-Domains](screens/m5/Admin-Brand-Domains.png)


### M6 Telegram

#### `Admin/Channels-Telegram`

![Admin/Channels-Telegram](screens/m6/Admin-Channels-Telegram.png)

#### `Admin/Ticket-Telegram`

![Admin/Ticket-Telegram](screens/m6/Admin-Ticket-Telegram.png)

#### `Telegram/Chat-EN`

![Telegram/Chat-EN](screens/m6/Telegram-Chat-EN.png)

#### `Telegram/Chat-AR`

![Telegram/Chat-AR](screens/m6/Telegram-Chat-AR.png)


### M7 AI

#### `Admin/AI-Providers`

![Admin/AI-Providers](screens/m7/Admin-AI-Providers.png)

#### `Admin/AI-Knowledge`

![Admin/AI-Knowledge](screens/m7/Admin-AI-Knowledge.png)

#### `Admin/AI-Assistant`

![Admin/AI-Assistant](screens/m7/Admin-AI-Assistant.png)

#### `Admin/Wizard-AI`

![Admin/Wizard-AI](screens/m7/Admin-Wizard-AI.png)

#### `Admin/Ticket-AI`

![Admin/Ticket-AI](screens/m7/Admin-Ticket-AI.png)

#### `Widget/AI-EN`

![Widget/AI-EN](screens/m7/Widget-AI-EN.png)

#### `Widget/AI-AR`

![Widget/AI-AR](screens/m7/Widget-AI-AR.png)

#### `Admin/HelpCenter-ArticleApproval`

![Admin/HelpCenter-ArticleApproval](screens/m7/Admin-HelpCenter-ArticleApproval.png)


### M8 API, webhooks, reports

#### `Admin/Developers-ApiKeys`

![Admin/Developers-ApiKeys](screens/m8/Admin-Developers-ApiKeys.png)

#### `Admin/Developers-Webhooks`

![Admin/Developers-Webhooks](screens/m8/Admin-Developers-Webhooks.png)

#### `Admin/Reports`

![Admin/Reports](screens/m8/Admin-Reports.png)

#### `Admin/System-1.0`

![Admin/System-1.0](screens/m8/Admin-System-1.0.png)

#### `Email/CSAT-EN-AR`

![Email/CSAT-EN-AR](screens/m8/Email-CSAT-EN-AR.png)

#### `Widget/CSAT-EN`

![Widget/CSAT-EN](screens/m8/Widget-CSAT-EN.png)

#### `Widget/CSAT-AR`

![Widget/CSAT-AR](screens/m8/Widget-CSAT-AR.png)
