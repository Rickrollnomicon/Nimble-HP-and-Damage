## [3.0.0] - 2026-04-17

### Added
- Full implementation of Enhanced Chat Cards for damage application
- Inline damage control panel within chat cards
- Armor interaction controls (Heavy / Medium / Bypass)
- Resist / Vulnerable toggles within chat cards
- Defend state controls for PCs
- Real-time target updates within chat cards
- Inline damage preview showing calculation adjustments
- Unified damage pipeline between chat cards and floating tracker
- Automatic Temp HP consumption for chat-card damage
- Dying condition automation when PCs reach 0 HP via chat cards
- Wound system integration:
  - +1 Wound when Dying is first applied
  - +1 Wound for additional damage while Dying
- Automatic removal of Dying when healed above 0 HP via chat cards
- Full undo restoration including:
  - HP
  - Temp HP
  - Dying condition
  - Wounds
- Verification chat cards now trigger only after confirmed HP application

### Changed
- Chat cards and floating tracker now use a shared damage application logic
- Improved consistency between chat-driven and HUD-driven interactions
- Healing chat cards now properly exclude damage enhancement controls
- Enhanced reliability of damage application feedback under latency conditions

### Removed
- False “Damage Applied” confirmations from unverified relay attempts

---

## [2.3.0] - 2026-03-27

### Added
- Undo button for targeted damage and healing chat cards
- Player-safe undo via GM relay
- Ownership restrictions for undo actions

### Removed
- Bloodied automation removed, now that Nimble core handles it natively