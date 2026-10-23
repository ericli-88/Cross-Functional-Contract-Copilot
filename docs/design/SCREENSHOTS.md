# Native Feishu desktop screenshots

The six README figures are simulated contract-bot scenes inside a faithful Feishu desktop-client layout. They use English text and fictional people/contracts. They are not live application captures and do not imply that the runtime has been translated into English.

## Visual references

The client shell and controls follow official product references:

- [Feishu: send message cards with an app bot](https://open.feishu.cn/document/common-capabilities/message-card/getting-started/quick-start): native bot sender row, BOT badge, interactive-card outline/header/buttons, document links, conversation toolbar and composer.
- [Lark: get started with Messenger](https://www.larksuite.com/hc/en-US/articles/191742533872-get-started-with-messenger): English navigation labels, real desktop icons, chat-list proportions, selected conversation and message layout.

Lark provides the official English desktop reference from the same product family. The figures preserve recognizable client chrome instead of inventing a generic messenger, dashboard, diagram or presentation layout. Actual installed versions can differ in minor controls.

## Creation method

The images were created with the built-in ImageGen tool, using official screenshots as visual references and then editing a common approved-looking client shell into the other scenes. No CLI fallback, private app screenshot, real contract, or user API credential was used. English message copy is adapted from the project workflow and offline fixtures.

The full prompts and reference-page URLs are recorded in [`screenshot-prompts.json`](screenshot-prompts.json). The committed asset hashes and dimensions are in [`screenshot-assets.json`](screenshot-assets.json). Source downloads used during visual reference work are local-only and ignored by Git.

| Asset | Native client scene |
| --- | --- |
| `01-functional-review.png` | Group chat with one interactive summary card and stacked Finance, Operations, Commercial and Legal revision guidance |
| `02-group-intake.png` | User submits a linked Feishu document; the bot acknowledges that V1 review has started |
| `03-owner-guidance.png` | Finance owner receives a private role card with native task/history and document buttons |
| `04-version-workflow.png` | Chronological chat shows an unchanged-content card, a later document update and V2 review acknowledgement |
| `05-status-control.png` | A person confirms completion and later reopens Finance; the bot publishes native green/blue status cards |
| `06-input-boundaries.png` | A native Word file tile is quoted in a reply; the bot returns attachment review without an invented online-document link |

## Maintenance

`pnpm demo` exports workflow evidence; it does not generate or overwrite these images. To change a screenshot, use the recorded prompt with the built-in ImageGen editing workflow and preserve the same application chrome, English copy and unobtrusive simulation note. Inspect every result for readable text, native control shapes, correct roles and complete cards before replacing the committed file.

After an intentional asset replacement, update its dimensions and SHA-256 in the asset manifest, then run:

```sh
python scripts/verify-screenshots.py
```

The previous custom Pillow layout generator was removed because it produced a generic presentation-style interface rather than a convincing Feishu client. The audit command checks the selected screenshots without redrawing them.
