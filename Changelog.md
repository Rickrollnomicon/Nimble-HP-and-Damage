## [3.1.3] - 2026-05-30

### Added

- New setting: Enable Enhanced/Alternate Dice Pool Functionality
  - Enables the module's legacy Judgment Dice and Fury Dice management tools on Enhanced Chat Cards and the Floating HUD.
  -  Disabled by default for new installations.

### Changed

- Enhanced Chat Cards and the Floating HUD now recognize Nimble Core's native Judgment Dice and Fury Dice pool values when calculating armor reduction in Original "Just the Dice" armor mode.
- Pool values are treated as dice-based damage for Medium Armor, Heavy Armor, Resistance, Vulnerability, and armor bypass calculations.
- Legacy Fury Dice and Judgment Dice controls are automatically hidden when the alternate dice pool setting is disabled, reducing UI clutter and avoiding redundant functionality.

### Compatibility

- Updated for improved compatibility with Nimble v0.8.6 and its native dice pool system.

---

## [3.1.2] - 2026-05-22

### Changed

- Updated some wording in Settings, and set the "Enhanced Chat Card" setting to default activated. 

## [3.1.1] - 2026-05-17

### Fixed
- Armor calculations in "Just the Dice" mode now include the flat bonuses from the roll when the roll details are expanded.  Previously it was reverting to the roll total.

---

## [3.1.0] - 2026-05-17

### Added
- Added a GM-configurable Monster Armor Rule setting:
  - Original / Just the Dice
  - Flat Reduction / Playtest
- Added Flat Reduction monster armor support:
  - Medium Armor: -5
  - Heavy Armor: -10
- Added Vicious Opportunist support for Cheat attacks:
  - Enhanced Chat Cards
  - Floating HUD Extra Damage Options
- Added persistent Misc Bonus support for Enhanced Chat Cards and HUD synchronization.
  - "Just the Dice" mode separates flat vs. dice bonus for armor calculations
  - Playtest mode simplifies to single flat bonus since dice vs. flat doesn't matter in that mode 

### Changed
- Unified damage recalculation handling across:
  - Enhanced Chat Cards
  - Floating HUD
  - HUD synchronization
  - Apply/Undo logic

### Removed
- Removed module-side monster Dead automation now that Nimble Core handles monster death conditions natively.

---

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