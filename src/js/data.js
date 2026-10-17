'use strict';

/**
 * Game catalogue.
 *
 * Artwork: games that live on Steam pull real cover / hero / header art from
 * the public Steam CDN. Games that are not on Steam (or custom games the user
 * adds) fall back to the generated typographic banner in banner.js, so nothing
 * ever renders broken.
 *
 * `steamAppId` lets the main process match a real installed Steam title to a
 * catalogue entry; `epicNames` does the same for Epic Games manifests, and
 * `gogIds` for GOG, whose registry entries are keyed by product id rather than
 * by name. Only ids that have been checked against GOG's own catalogue are
 * listed: a wrong id would silently bind a title to the wrong install.
 */

const STEAM = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';
const steamArt = (id) => ({
  cover: `${STEAM}${id}/library_600x900.jpg`,
  hero: `${STEAM}${id}/library_hero.jpg`,
  wide: `${STEAM}${id}/header.jpg`,
  logo: `${STEAM}${id}/logo.png`
});

const GAMES = [
  {
    id: 'gta5', title: 'Grand Theft Auto V', developer: 'Rockstar North', release: 2015,
    genre: 'Action', tags: ['Open World', 'Multiplayer', 'Crime'], size: 105.0, price: '$29.99', rating: 4.8,
    blurb: 'Three criminals, one sprawling city and the heist of a lifetime in Los Santos.',
    colors: ['#1d4e2a', '#f2a900'], steamAppId: '271590', ...steamArt(271590)
  },
  {
    id: 'cyberpunk', title: 'Cyberpunk 2077', developer: 'CD Projekt Red', release: 2020,
    genre: 'RPG', tags: ['Open World', 'Sci-Fi', 'Story Rich'], size: 70.0, price: '$59.99', rating: 4.5,
    blurb: 'An open-world action RPG set in the neon-soaked dark future of Night City.',
    colors: ['#fcee0a', '#e0245e'], steamAppId: '1091500', ...steamArt(1091500), gogIds: ['1423049311']
  },
  {
    id: 'rdr2', title: 'Red Dead Redemption 2', developer: 'Rockstar Games', release: 2018,
    genre: 'Action', tags: ['Open World', 'Western', 'Story Rich'], size: 119.0, price: '$59.99', rating: 4.9,
    blurb: 'Outlaw Arthur Morgan and the Van der Linde gang fight to survive a changing America.',
    colors: ['#7a1f1f', '#d9a441'], steamAppId: '1174180', ...steamArt(1174180)
  },
  {
    id: 'witcher3', title: 'The Witcher 3: Wild Hunt', developer: 'CD Projekt Red', release: 2015,
    genre: 'RPG', tags: ['Fantasy', 'Open World', 'Story Rich'], size: 50.0, price: '$39.99', rating: 4.9,
    blurb: 'Hunt monsters and track down the Child of Prophecy as Geralt of Rivia.',
    colors: ['#3a3d40', '#b11226'], steamAppId: '292030', ...steamArt(292030)
  },
  {
    id: 'eldenring', title: 'Elden Ring', developer: 'FromSoftware', release: 2022,
    genre: 'Action RPG', tags: ['Souls-like', 'Open World', 'Difficult'], size: 60.0, price: '$59.99', rating: 4.8,
    blurb: 'Rise, Tarnished, and brave the vast and merciless Lands Between.',
    colors: ['#2b2412', '#d4af37'], steamAppId: '1245620', ...steamArt(1245620)
  },
  {
    id: 'bg3', title: "Baldur's Gate 3", developer: 'Larian Studios', release: 2023,
    genre: 'RPG', tags: ['Turn-Based', 'Co-op', 'Story Rich'], size: 150.0, price: '$59.99', rating: 4.9,
    blurb: 'Gather your party and return to the Forgotten Realms in a tale of choice and consequence.',
    colors: ['#2a1b3d', '#c0392b'], steamAppId: '1086940', ...steamArt(1086940), gogIds: ['1456460669']
  },
  {
    id: 'cs2', title: 'Counter-Strike 2', developer: 'Valve', release: 2023,
    genre: 'Shooter', tags: ['FPS', 'Competitive', 'Free to Play'], size: 33.0, price: 'Free', rating: 4.4,
    blurb: 'The next era of the world\'s premier tactical shooter, rebuilt on Source 2.',
    colors: ['#1c2a3a', '#f0a30a'], steamAppId: '730', ...steamArt(730)
  },
  {
    id: 'dota2', title: 'Dota 2', developer: 'Valve', release: 2013,
    genre: 'MOBA', tags: ['Free to Play', 'Strategy', 'Competitive'], size: 40.0, price: 'Free', rating: 4.3,
    blurb: 'Two teams of five battle to destroy the enemy Ancient in this deep MOBA.',
    colors: ['#3a1010', '#d4a24c'], steamAppId: '570', ...steamArt(570)
  },
  {
    id: 'apex', title: 'Apex Legends', developer: 'Respawn Entertainment', release: 2019,
    genre: 'Shooter', tags: ['Battle Royale', 'FPS', 'Free to Play'], size: 55.0, price: 'Free', rating: 4.5,
    blurb: 'Legendary heroes with powerful abilities clash in fast, squad-based battle royale.',
    colors: ['#3a1418', '#ff5c5c'], steamAppId: '1172470', ...steamArt(1172470)
  },
  {
    id: 'rocketleague', title: 'Rocket League', developer: 'Psyonix', release: 2015,
    genre: 'Sports', tags: ['Racing', 'Esports', 'Free to Play'], size: 20.0, price: 'Free', rating: 4.6,
    blurb: 'Soccer meets rocket-powered cars in this high-flying arena classic.',
    colors: ['#0b3d91', '#ff7a00'], steamAppId: '252950', epicNames: ['Rocket League'], ...steamArt(252950)
  },
  {
    id: 'pubg', title: 'PUBG: BATTLEGROUNDS', developer: 'KRAFTON', release: 2017,
    genre: 'Shooter', tags: ['Battle Royale', 'FPS', 'Free to Play'], size: 40.0, price: 'Free', rating: 4.0,
    blurb: 'Land, loot and outlast one hundred players on massive battlegrounds.',
    colors: ['#2b2b2b', '#e2b13c'], steamAppId: '578080', ...steamArt(578080)
  },
  {
    id: 'hollowknight', title: 'Hollow Knight', developer: 'Team Cherry', release: 2017,
    genre: 'Metroidvania', tags: ['Indie', 'Difficult', 'Atmospheric'], size: 9.0, price: '$14.99', rating: 4.9,
    blurb: 'Forge your own path through a vast ruined kingdom of insects and heroes.',
    colors: ['#101820', '#6ec6ff'], steamAppId: '367520', ...steamArt(367520), gogIds: ['1308320804']
  },
  {
    id: 'spiderman', title: "Marvel's Spider-Man Remastered", developer: 'Insomniac Games', release: 2022,
    genre: 'Action', tags: ['Open World', 'Superhero', 'Story Rich'], size: 75.0, price: '$59.99', rating: 4.7,
    blurb: 'Swing across a vibrant recreation of New York as an experienced Peter Parker.',
    colors: ['#b3121a', '#1f5fd0'], steamAppId: '1817070', ...steamArt(1817070)
  },
  {
    id: 'spiderman-miles', title: "Marvel's Spider-Man: Miles Morales", developer: 'Insomniac Games', release: 2022,
    genre: 'Action', tags: ['Open World', 'Superhero', 'Story Rich'], size: 50.0, price: '$49.99', rating: 4.7,
    blurb: 'Master explosive venom powers and web-sling through a snow-dusted Harlem.',
    colors: ['#0d0d12', '#ff2d55'], steamAppId: '1817190', ...steamArt(1817190)
  },
  {
    id: 'kcd', title: 'Kingdom Come: Deliverance', developer: 'Warhorse Studios', release: 2018,
    genre: 'RPG', tags: ['Historical', 'Open World', 'Hardcore'], size: 60.0, price: '$29.99', rating: 4.4,
    blurb: 'A story-driven medieval RPG set in the chaos of a war-torn Bohemia.',
    colors: ['#5a3a1a', '#c8b287'], steamAppId: '379430', ...steamArt(379430)
  },
  {
    id: 'kcd2', title: 'Kingdom Come: Deliverance II', developer: 'Warhorse Studios', release: 2025,
    genre: 'RPG', tags: ['Historical', 'Open World', 'Story Rich'], size: 100.0, price: '$59.99', rating: 4.7,
    blurb: 'Continue the journey through a sprawling medieval sandbox of choices and consequence.',
    colors: ['#2f2a22', '#b8963f'], steamAppId: '1771300', ...steamArt(1771300)
  },
  {
    id: 'ds3', title: 'DARK SOULS III', developer: 'FromSoftware', release: 2016,
    genre: 'Action RPG', tags: ['Souls-like', 'Difficult', 'Fantasy'], size: 25.0, price: '$59.99', rating: 4.8,
    blurb: 'Only embers remain. Face the Lords of Cinder in a dying, ash-choked world.',
    colors: ['#141414', '#c9a24a'], steamAppId: '374320', ...steamArt(374320)
  },
  {
    id: 'ultrakill', title: 'ULTRAKILL', developer: 'Arsi "Hakita" Patala', release: 2020,
    genre: 'Shooter', tags: ['Retro', 'FPS', 'Fast-Paced'], size: 3.5, price: '$24.99', rating: 4.9,
    blurb: 'Blood is fuel. A blistering, movement-driven retro shooter that runs on anything.',
    colors: ['#101014', '#ff2e2e'], steamAppId: '1229490', ...steamArt(1229490), gogIds: ['1476171749']
  },
  {
    id: 'stray', title: 'Stray', developer: 'BlueTwelve Studio', release: 2022,
    genre: 'Adventure', tags: ['Cyberpunk', 'Atmospheric', 'Indie'], size: 10.0, price: '$29.99', rating: 4.7,
    blurb: 'A lost cat navigates a neon-lit cybercity of robots to find its way home.',
    colors: ['#1b1030', '#ff9f43'], steamAppId: '1332010', ...steamArt(1332010)
  },
  {
    id: 'terraria', title: 'Terraria', developer: 'Re-Logic', release: 2011,
    genre: 'Sandbox', tags: ['Survival', 'Indie', 'Co-op'], size: 0.5, price: '$9.99', rating: 4.9,
    blurb: 'Dig, fight, explore and build in a procedurally generated 2D world.',
    colors: ['#1c3b2a', '#8bc34a'], steamAppId: '105600', ...steamArt(105600), gogIds: ['1207665503']
  },
  {
    id: 'stardew', title: 'Stardew Valley', developer: 'ConcernedApe', release: 2016,
    genre: 'Simulation', tags: ['Farming', 'Indie', 'Relaxing'], size: 0.5, price: '$14.99', rating: 4.9,
    blurb: 'Inherit your grandfather\'s old farm and build a new life in the valley.',
    colors: ['#2f5d3a', '#f4c542'], steamAppId: '413150', ...steamArt(413150), gogIds: ['1453375253']
  },
  {
    id: 'amongus', title: 'Among Us', developer: 'InnerSloth', release: 2018,
    genre: 'Party', tags: ['Social Deduction', 'Co-op', 'Casual'], size: 0.25, price: '$4.99', rating: 4.2,
    blurb: 'Work together, watch your back and find the impostor aboard the ship.',
    colors: ['#241436', '#e14b6a'], steamAppId: '945360', epicNames: ['Among Us'], ...steamArt(945360)
  },
  {
    id: 'fortnite', title: 'Fortnite', developer: 'Epic Games', release: 2017,
    genre: 'Battle Royale', tags: ['Free to Play', 'Building', 'Cross-Platform'], size: 30.0, price: 'Free', rating: 4.3,
    blurb: 'Drop in, build, and be the last one standing on a constantly evolving island.',
    colors: ['#1b2a63', '#7b40f2'], epicNames: ['Fortnite'], artKey: 'fortnite',
    // Fortnite is not on Steam, so the art comes straight from Epic's own CDN
    // (the same launcher key art used on the Epic Games Store). `artKey` keeps
    // the hand-drawn storm banner as the offline fallback.
    cover: 'https://cdn2.unrealengine.com/en-fn-og-42-10-c1sx-egs-launcher-blade-1200x1600-1200x1600-6e74a083a5cd.jpg',
    wide: 'https://cdn2.unrealengine.com/en-fn-og-42-10-c1sx-egs-launcher-blade-2560x1440-2560x1440-319ff81b274e.jpg',
    hero: 'https://cdn2.unrealengine.com/en-fn-og-42-10-c1sx-egs-launcher-blade-2560x1440-2560x1440-319ff81b274e.jpg',
    logo: 'https://cdn2.unrealengine.com/fnsp-01-egs-launcher-logo-350x100-350x100-3e6795f4d363.png',
    officialUrl: 'https://www.fortnite.com/'
  },
  {
    id: 'valorant', title: 'VALORANT', developer: 'Riot Games', release: 2020,
    genre: 'Shooter', tags: ['Tactical', 'FPS', 'Free to Play'], size: 27.0, price: 'Free', rating: 4.5,
    blurb: 'Precise gunplay meets unique agent abilities in tense 5v5 tactical combat.',
    colors: ['#ff4655', '#0f1923'], wide: null,
    // Riot serves no crawlable key visual, so the official wordmark (freely
    // licensed on Wikimedia Commons) is centred over the generated banner.
    cover: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fc/Valorant_logo_-_pink_color_version.svg/960px-Valorant_logo_-_pink_color_version.svg.png',
    artContain: true,
    officialUrl: 'https://playvalorant.com/'
  },
  {
    id: 'warframe', title: 'Warframe', developer: 'Digital Extremes', release: 2013,
    genre: 'Action', tags: ['Free to Play', 'Co-op', 'Sci-Fi'], size: 45.0, price: 'Free', rating: 4.4,
    blurb: 'Awaken as a Tenno and master the ancient art of the blade and gun.',
    colors: ['#0e2436', '#4fc3f7'], steamAppId: '230410', ...steamArt(230410)
  },
  {
    id: 'eso', title: 'The Elder Scrolls Online', developer: 'ZeniMax Online Studios', release: 2014,
    genre: 'MMORPG', tags: ['Fantasy', 'MMO', 'Open World'], size: 95.0, price: '$19.99', rating: 4.4,
    blurb: 'Explore Tamriel alone or with millions of players in the award-winning online Elder Scrolls.',
    colors: ['#22303f', '#c8a45c'], steamAppId: '306130', ...steamArt(306130)
  },

  // --- Modern blockbusters ---------------------------------------------------
  {
    id: 'sekiro', title: 'Sekiro: Shadows Die Twice', developer: 'FromSoftware', release: 2019,
    genre: 'Action', tags: ['Souls-like', 'Difficult', 'Ninja'], size: 15.0, price: '$59.99', rating: 4.8,
    blurb: 'Carve a bloody path through Sengoku-era Japan as a shinobi bound by honour.',
    colors: ['#20262b', '#c0392b'], steamAppId: '814380', ...steamArt(814380)
  },
  {
    id: 'doometernal', title: 'DOOM Eternal', developer: 'id Software', release: 2020,
    genre: 'Shooter', tags: ['FPS', 'Fast-Paced', 'Demons'], size: 80.0, price: '$39.99', rating: 4.7,
    blurb: 'Rip and tear across Earth and Hell in the most kinetic shooter ever made.',
    colors: ['#3a1206', '#ff7a1a'], steamAppId: '782330', ...steamArt(782330), gogIds: ['1344230395']
  },
  {
    id: 'godofwar', title: 'God of War', developer: 'Santa Monica Studio', release: 2022,
    genre: 'Action', tags: ['Mythology', 'Story Rich', 'Cinematic'], size: 70.0, price: '$49.99', rating: 4.9,
    blurb: 'Kratos and Atreus journey through the Norse realms in a tale of father and son.',
    colors: ['#22303c', '#c1440e'], steamAppId: '1593500', ...steamArt(1593500)
  },
  {
    id: 'blackmyth', title: 'Black Myth: Wukong', developer: 'Game Science', release: 2024,
    genre: 'Action RPG', tags: ['Mythology', 'Souls-like', 'Cinematic'], size: 130.0, price: '$59.99', rating: 4.6,
    blurb: 'Wield the staff of the Destined One through a myth-soaked Chinese fantasy.',
    colors: ['#2b1a12', '#d9a441'], steamAppId: '2358720', ...steamArt(2358720)
  },
  {
    id: 'palworld', title: 'Palworld', developer: 'Pocketpair', release: 2024,
    genre: 'Survival', tags: ['Creature Collector', 'Open World', 'Co-op'], size: 40.0, price: '$29.99', rating: 4.4,
    blurb: 'Catch, farm and fight alongside Pals in a wide-open survival sandbox.',
    colors: ['#1c3559', '#5ec7f2'], steamAppId: '1623730', ...steamArt(1623730)
  },
  {
    id: 'helldivers2', title: 'HELLDIVERS 2', developer: 'Arrowhead Game Studios', release: 2024,
    genre: 'Shooter', tags: ['Co-op', 'Third-Person', 'Sci-Fi'], size: 100.0, price: '$39.99', rating: 4.6,
    blurb: 'Drop with your squad and spread managed democracy across a hostile galaxy.',
    colors: ['#1b2436', '#f2c14e'], steamAppId: '553850', ...steamArt(553850)
  },
  {
    id: 'persona5royal', title: 'Persona 5 Royal', developer: 'ATLUS', release: 2022,
    genre: 'JRPG', tags: ['Turn-Based', 'Story Rich', 'Stylish'], size: 40.0, price: '$59.99', rating: 4.9,
    blurb: 'Steal hearts as a Phantom Thief in Tokyo\'s most stylish turn-based RPG.',
    colors: ['#0f0f14', '#e2231a'], steamAppId: '1687950', ...steamArt(1687950)
  },
  {
    id: 'ittakestwo', title: 'It Takes Two', developer: 'Hazelight Studios', release: 2021,
    genre: 'Adventure', tags: ['Co-op', 'Platformer', 'Story Rich'], size: 50.0, price: '$39.99', rating: 4.8,
    blurb: 'Two players, one wildly inventive co-op journey through a broken marriage.',
    colors: ['#2a1b3d', '#ff5c8a'], steamAppId: '1426210', ...steamArt(1426210)
  },
  {
    id: 'nomanssky', title: "No Man's Sky", developer: 'Hello Games', release: 2016,
    genre: 'Survival', tags: ['Space', 'Open World', 'Exploration'], size: 15.0, price: '$59.99', rating: 4.6,
    blurb: 'Explore an effectively infinite universe of planets, each with its own life.',
    colors: ['#12263a', '#ff9f43'], steamAppId: '275850', ...steamArt(275850), gogIds: ['1446213994']
  },
  {
    id: 'subnautica', title: 'Subnautica', developer: 'Unknown Worlds', release: 2018,
    genre: 'Survival', tags: ['Underwater', 'Exploration', 'Crafting'], size: 6.0, price: '$29.99', rating: 4.8,
    blurb: 'Survive a crash on an ocean planet whose depths get stranger the deeper you go.',
    colors: ['#08293c', '#22d3ee'], steamAppId: '264710', ...steamArt(264710)
  },

  // --- Indie gems ------------------------------------------------------------
  {
    id: 'hades', title: 'Hades', developer: 'Supergiant Games', release: 2020,
    genre: 'Roguelike', tags: ['Action', 'Roguelike', 'Indie'], size: 15.0, price: '$24.99', rating: 4.9,
    blurb: 'Fight your way out of the Underworld, dying gloriously over and over.',
    colors: ['#2a0f14', '#f0533f'], steamAppId: '1145360', ...steamArt(1145360)
  },
  {
    id: 'celeste', title: 'Celeste', developer: 'Maddy Makes Games', release: 2018,
    genre: 'Platformer', tags: ['Difficult', 'Pixel Art', 'Indie'], size: 1.2, price: '$19.99', rating: 4.9,
    blurb: 'Climb a mountain and, along the way, everything you are afraid of.',
    colors: ['#1b2a45', '#f25c8a'], steamAppId: '504230', ...steamArt(504230)
  },
  {
    id: 'vampiresurvivors', title: 'Vampire Survivors', developer: 'poncle', release: 2022,
    genre: 'Roguelike', tags: ['Bullet Heaven', 'Casual', 'Indie'], size: 0.5, price: '$4.99', rating: 4.8,
    blurb: 'One stick, a screen of monsters and a build that snowballs out of control.',
    colors: ['#1a1030', '#c0392b'], steamAppId: '1794680', ...steamArt(1794680)
  },
  {
    id: 'discoelysium', title: 'Disco Elysium', developer: 'ZA/UM', release: 2019,
    genre: 'RPG', tags: ['Detective', 'Story Rich', 'Choices Matter'], size: 20.0, price: '$39.99', rating: 4.9,
    blurb: 'A detective story where your own fractured mind is the hardest suspect.',
    colors: ['#1a1f2b', '#d9743f'], steamAppId: '632470', ...steamArt(632470), gogIds: ['1771589310']
  },
  {
    id: 'inscryption', title: 'Inscryption', developer: 'Daniel Mullins Games', release: 2021,
    genre: 'Card', tags: ['Roguelike', 'Horror', 'Puzzle'], size: 4.0, price: '$19.99', rating: 4.8,
    blurb: 'A card game in a cabin in the woods that is very much not just a card game.',
    colors: ['#14100e', '#c9a24a'], steamAppId: '1092790', ...steamArt(1092790), gogIds: ['1224800338']
  },
  {
    id: 'slaythespire', title: 'Slay the Spire', developer: 'Mega Crit', release: 2019,
    genre: 'Card', tags: ['Deckbuilder', 'Roguelike', 'Strategy'], size: 1.0, price: '$24.99', rating: 4.8,
    blurb: 'Build a deck, climb the Spire and learn that every choice costs something.',
    colors: ['#2b1a12', '#e0a34a'], steamAppId: '646570', ...steamArt(646570)
  },
  {
    id: 'deadcells', title: 'Dead Cells', developer: 'Motion Twin', release: 2018,
    genre: 'Roguelike', tags: ['Metroidvania', 'Action', 'Pixel Art'], size: 1.5, price: '$24.99', rating: 4.7,
    blurb: 'A rogue-lite Metroidvania where dying is just the next attempt.',
    colors: ['#1a2436', '#4fc3f7'], steamAppId: '588650', ...steamArt(588650)
  },
  {
    id: 'riskofrain2', title: 'Risk of Rain 2', developer: 'Hopoo Games', release: 2020,
    genre: 'Roguelike', tags: ['Third-Person', 'Co-op', 'Difficulty Scales'], size: 4.0, price: '$24.99', rating: 4.7,
    blurb: 'The difficulty never stops climbing. Neither should you.',
    colors: ['#241a2e', '#f0a30a'], steamAppId: '632360', ...steamArt(632360)
  },
  {
    id: 'cuphead', title: 'Cuphead', developer: 'Studio MDHR', release: 2017,
    genre: 'Platformer', tags: ['Boss Rush', 'Hand-Drawn', 'Difficult'], size: 4.0, price: '$19.99', rating: 4.8,
    blurb: 'A run-and-gun drawn in gorgeous 1930s cartoon ink — with brutal bosses.',
    colors: ['#1b1220', '#e8b23a'], steamAppId: '268910', ...steamArt(268910)
  },
  {
    id: 'ori-wisps', title: 'Ori and the Will of the Wisps', developer: 'Moon Studios', release: 2020,
    genre: 'Metroidvania', tags: ['Platformer', 'Atmospheric', 'Beautiful'], size: 6.0, price: '$29.99', rating: 4.9,
    blurb: 'A luminous, heart-breaking Metroidvania about a spirit\'s second journey.',
    colors: ['#10283a', '#7ee0d0'], steamAppId: '1057090', ...steamArt(1057090)
  },
  {
    id: 'outerwilds', title: 'Outer Wilds', developer: 'Mobius Digital', release: 2019,
    genre: 'Adventure', tags: ['Exploration', 'Mystery', 'Time Loop'], size: 8.0, price: '$24.99', rating: 4.9,
    blurb: 'A solar system stuck in a 22-minute loop, and only knowledge carries over.',
    colors: ['#1b1430', '#f2a65a'], steamAppId: '753640', ...steamArt(753640)
  },
  {
    id: 'undertale', title: 'Undertale', developer: 'tobyfox', release: 2015,
    genre: 'RPG', tags: ['Story Rich', 'Pixel Art', 'Choices Matter'], size: 0.2, price: '$9.99', rating: 4.9,
    blurb: 'The RPG where nobody has to die — if you can live with the alternative.',
    colors: ['#161618', '#e34a4a'], steamAppId: '391540', ...steamArt(391540)
  },
  {
    id: 'balatro', title: 'Balatro', developer: 'LocalThunk', release: 2024,
    genre: 'Card', tags: ['Roguelike', 'Poker', 'Deckbuilder'], size: 0.2, price: '$14.99', rating: 4.9,
    blurb: 'Poker hands, impossible decks and a joker for every bad idea you have.',
    colors: ['#141a2e', '#e8452c'], steamAppId: '2379780', ...steamArt(2379780)
  },
  {
    id: 'lethalcompany', title: 'Lethal Company', developer: 'Zeekerss', release: 2023,
    genre: 'Horror', tags: ['Co-op', 'Horror', 'Funny'], size: 2.0, price: '$9.99', rating: 4.7,
    blurb: 'Scavenge abandoned moons with your crew. Most of your crew will not return.',
    colors: ['#14181c', '#8bc34a'], steamAppId: '1966720', ...steamArt(1966720)
  },
  {
    id: 'portal2', title: 'Portal 2', developer: 'Valve', release: 2011,
    genre: 'Puzzle', tags: ['Co-op', 'Puzzle', 'Funny'], size: 13.0, price: '$9.99', rating: 4.9,
    blurb: 'Think with portals across a collapsing Aperture Science facility.',
    colors: ['#12212b', '#f2a30a'], steamAppId: '620', ...steamArt(620)
  },
  {
    id: 'isaac', title: 'The Binding of Isaac: Rebirth', developer: 'Nicalis', release: 2014,
    genre: 'Roguelike', tags: ['Twin-Stick', 'Difficult', 'Dark'], size: 1.0, price: '$14.99', rating: 4.8,
    blurb: 'Descend into the basement: a bleak, brilliant twin-stick roguelike.',
    colors: ['#20141c', '#c0392b'], steamAppId: '250900', ...steamArt(250900)
  },

  // --- Build, survive & co-op ------------------------------------------------
  {
    id: 'factorio', title: 'Factorio', developer: 'Wube Software', release: 2020,
    genre: 'Simulation', tags: ['Automation', 'Building', 'Optimisation'], size: 3.0, price: '$35.00', rating: 4.9,
    blurb: 'Build a factory. Grow the factory. The factory must grow.',
    colors: ['#2b2213', '#f2a30a'], steamAppId: '427520', ...steamArt(427520)
  },
  {
    id: 'satisfactory', title: 'Satisfactory', developer: 'Coffee Stain Studios', release: 2024,
    genre: 'Simulation', tags: ['Automation', 'Open World', 'Co-op'], size: 15.0, price: '$39.99', rating: 4.8,
    blurb: 'Turn an alien world into a sprawling, hundred-hour conveyor-belt empire.',
    colors: ['#1c2a1f', '#ff9f43'], steamAppId: '526870', ...steamArt(526870)
  },
  {
    id: 'rimworld', title: 'RimWorld', developer: 'Ludeon Studios', release: 2018,
    genre: 'Simulation', tags: ['Colony Sim', 'Story Generator', 'Deep'], size: 0.5, price: '$34.99', rating: 4.9,
    blurb: 'A sci-fi colony sim that turns every disaster into a story you tell later.',
    colors: ['#241d16', '#c9a24a'], steamAppId: '294100', ...steamArt(294100)
  },
  {
    id: 'valheim', title: 'Valheim', developer: 'Iron Gate AB', release: 2021,
    genre: 'Survival', tags: ['Viking', 'Co-op', 'Building'], size: 1.0, price: '$19.99', rating: 4.7,
    blurb: 'Forge your way through the tenth world of Norse myth, alone or with a crew.',
    colors: ['#1b2430', '#7ec8e3'], steamAppId: '892970', ...steamArt(892970)
  },
  {
    id: 'projectzomboid', title: 'Project Zomboid', developer: 'The Indie Stone', release: 2013,
    genre: 'Survival', tags: ['Zombies', 'Hardcore', 'Sandbox'], size: 5.0, price: '$19.99', rating: 4.7,
    blurb: 'This is how you died. An unforgiving isometric zombie survival sim.',
    colors: ['#241f1a', '#a63a2a'], steamAppId: '108600', ...steamArt(108600)
  },
  {
    id: 'sonsoftheforest', title: 'Sons Of The Forest', developer: 'Endnight Games', release: 2024,
    genre: 'Survival', tags: ['Horror', 'Crafting', 'Co-op'], size: 10.0, price: '$29.99', rating: 4.4,
    blurb: 'Search a cannibal-infested island for a missing billionaire.',
    colors: ['#141a16', '#8bc34a'], steamAppId: '1326470', ...steamArt(1326470)
  },
  {
    id: 'deeprock', title: 'Deep Rock Galactic', developer: 'Ghost Ship Games', release: 2020,
    genre: 'Shooter', tags: ['Co-op', 'Mining', 'Sci-Fi'], size: 5.0, price: '$29.99', rating: 4.8,
    blurb: 'Rock and Stone! Four dwarves, one cave, and whatever is down there.',
    colors: ['#1a1f28', '#f2a30a'], steamAppId: '548430', ...steamArt(548430)
  },
  {
    id: 'l4d2', title: 'Left 4 Dead 2', developer: 'Valve', release: 2009,
    genre: 'Shooter', tags: ['Co-op', 'Zombies', 'Classic'], size: 13.0, price: '$9.99', rating: 4.8,
    blurb: 'Four survivors, one director and the definitive co-op zombie shooter.',
    colors: ['#1b2317', '#a63a2a'], steamAppId: '550', ...steamArt(550)
  },
  {
    id: 'tf2', title: 'Team Fortress 2', developer: 'Valve', release: 2007,
    genre: 'Shooter', tags: ['Class-Based', 'Free to Play', 'Multiplayer'], size: 25.0, price: 'Free', rating: 4.6,
    blurb: 'Nine mercenaries, endless hats and the class shooter that started it all.',
    colors: ['#33261a', '#e8a33d'], steamAppId: '440', ...steamArt(440)
  },
  {
    id: 'pathofexile', title: 'Path of Exile', developer: 'Grinding Gear Games', release: 2013,
    genre: 'ARPG', tags: ['Free to Play', 'Deep Builds', 'Dark'], size: 30.0, price: 'Free', rating: 4.5,
    blurb: 'A free-to-play action RPG with the deepest skill tree in the genre.',
    colors: ['#1a1a1f', '#b8863b'], steamAppId: '238960', ...steamArt(238960)
  }
];

// ---------------------------------------------------------------------------
// Known artwork for imported titles
// ---------------------------------------------------------------------------
/**
 * Real key art for well-known games that are not in the catalogue.
 *
 * The user's own imports (see import.js) and games that live only on a
 * non-Steam store create bare library entries with no artwork, so Apex would
 * otherwise fall back to a generated banner. Each entry here matches a title
 * and hands back the publisher's or platform's own artwork. Nothing is
 * invented: every URL is a real asset served by Steam's CDN or the Microsoft
 * Store, and titles that are not matched keep the generated banner.
 */
const MC_STORE = 'https://store-images.s-microsoft.com/image/';
const mcArt = (asset) => `${MC_STORE}${asset}`;

const KNOWN_ART = [
  {
    // Fall Guys lives on Steam (AppID 1097150), so its own cover art works here.
    test: /^fall\s*guys/i,
    art: {
      cover: `${STEAM}1097150/library_600x900.jpg`,
      wide: `${STEAM}1097150/header.jpg`,
      hero: `${STEAM}1097150/library_hero.jpg`,
      logo: `${STEAM}1097150/logo.png`
    }
  },
  {
    // Minecraft for Windows ships through the Microsoft Store, not Steam, so its
    // banner comes from that store's own listing art (product 9NBLGGH2JHXJ).
    test: /^minecraft(\s+for\s+windows|:?\s+windows\s*10\s*edition)?$/i,
    art: {
      cover: mcArt('apps.17382.13510798885735219.9735d495-578c-4a4c-b892-3eb3a780b3a0.d3792486-cf98-40c0-a2c1-d6443f0e2b70'),
      wide: mcArt('apps.415.13510798885735219.53a3b855-fde7-4304-925c-9db1cd1c34a8.b07e27c9-cdb1-4433-982b-7df0888f871c'),
      hero: mcArt('apps.415.13510798885735219.53a3b855-fde7-4304-925c-9db1cd1c34a8.b07e27c9-cdb1-4433-982b-7df0888f871c'),
      logo: mcArt('apps.31326.13510798885735219.3dfb176a-2479-4b17-ab6e-418794f3932d.a8aae002-3be2-4cd4-9ca3-b3e2e7e14882')
    }
  }
];

/** The curated artwork for a title, or null when we have none for it. */
function knownArt(g) {
  const title = String((g && g.title) || '').trim();
  if (!title) return null;
  const hit = KNOWN_ART.find((k) => k.test.test(title));
  return hit ? hit.art : null;
}

// ---------------------------------------------------------------------------
// Store front page
// ---------------------------------------------------------------------------
/**
 * The curated Store catalogue, in the order it is presented. These are the
 * blockbuster titles the store is built around; Apex only ever installs a game
 * the account already owns (verified locally) and points everyone else at the
 * title's own store page.
 */
const CATALOG = [
  // Blockbusters first — the front page is built around them.
  'cyberpunk', 'gta5', 'spiderman', 'spiderman-miles', 'rdr2', 'witcher3', 'kcd', 'kcd2',
  'eldenring', 'eso', 'ds3', 'sekiro', 'doometernal', 'godofwar', 'blackmyth', 'helldivers2',
  'palworld', 'persona5royal', 'ittakestwo', 'nomanssky', 'subnautica',
  // Then the indie shelf, which is where most of the "browse something new" comes from.
  'hades', 'celeste', 'vampiresurvivors', 'discoelysium', 'inscryption', 'slaythespire',
  'deadcells', 'riskofrain2', 'cuphead', 'ori-wisps', 'outerwilds', 'undertale', 'balatro',
  'lethalcompany', 'stray', 'hollowknight', 'ultrakill',
  // And the long-tail co-op / building / live titles.
  'portal2', 'isaac', 'factorio', 'satisfactory', 'rimworld', 'valheim', 'projectzomboid',
  'sonsoftheforest', 'deeprock', 'l4d2', 'tf2', 'pathofexile', 'warframe', 'amongus',
  'apex', 'cs2', 'rocketleague', 'pubg', 'dota2'
];

/** The curated rows, grouped exactly as the catalogue is presented. */
const STORE_ROWS = [
  { title: 'Open-World &amp; Action Masterpieces', ico: 'globe',
    ids: ['cyberpunk', 'gta5', 'rdr2', 'spiderman', 'spiderman-miles', 'blackmyth', 'godofwar'] },
  { title: 'RPGs &amp; Story-Driven Adventures', ico: 'shield',
    ids: ['witcher3', 'eldenring', 'bg3', 'kcd', 'kcd2', 'eso', 'ds3', 'sekiro', 'persona5royal', 'discoelysium'] },
  { title: 'Shooters, Co-op &amp; Fast-Paced', ico: 'zap',
    ids: ['ultrakill', 'doometernal', 'helldivers2', 'deeprock', 'l4d2', 'cs2', 'apex', 'pubg', 'tf2'] },
  { title: 'Indie Gems &amp; Roguelikes', ico: 'sparkles',
    ids: ['hades', 'celeste', 'hollowknight', 'deadcells', 'riskofrain2', 'vampiresurvivors', 'balatro',
      'slaythespire', 'inscryption', 'lethalcompany', 'cuphead', 'ori-wisps', 'stray', 'outerwilds', 'undertale', 'isaac'] },
  { title: 'Build, Survive &amp; Explore', ico: 'box',
    ids: ['factorio', 'satisfactory', 'rimworld', 'valheim', 'projectzomboid', 'subnautica', 'nomanssky',
      'sonsoftheforest', 'palworld', 'terraria', 'stardew', 'portal2', 'ittakestwo', 'pathofexile', 'warframe'] }
];

/** Hero carousel slides. */
const FEATURED = ['cyberpunk', 'eldenring', 'blackmyth', 'witcher3', 'hades', 'spiderman'];

// ---------------------------------------------------------------------------
// Upcoming & pre-orders
// ---------------------------------------------------------------------------
/**
 * Titles that are announced but not yet released on PC.
 *
 * These are curated by hand rather than searched, because a game with no store
 * page cannot be returned by a store search — and inventing an AppID for one
 * would mean the Install button pointed at a stranger's game. Each entry
 * therefore carries its real official home page, and the pre-order button
 * simply opens that page so the user pre-orders from the publisher.
 *
 * Anything that *does* have a real store page shows up automatically: the live
 * Steam search marks `comingSoon` titles and offers them a pre-order link to
 * Steam itself, with the price Steam is actually charging.
 */
const UPCOMING = [
  {
    id: 'gta6',
    title: 'Grand Theft Auto VI',
    developer: 'Rockstar Games',
    release: 2026,
    genre: 'Action',
    tags: ['Open World', 'Crime', 'Pre-order'],
    price: '$79.99',
    size: 0,
    rating: 5.0,
    blurb: 'Vice City returns on 19 November 2026 for PS5 and Xbox Series X|S. The PC version has not been dated yet.',
    colors: ['#8a1f6d', '#ffb02e'],
    steamAppId: null,
    // Rockstar's own key visual (the share image on the official VI site).
    cover: 'https://www.rockstargames.com/VI/_next/static/media/meta.0t8ty~nlmxq2s.jpg?qXOoWo7_YJjVLK9jY_b4F',
    wide: 'https://www.rockstargames.com/VI/_next/static/media/meta.0t8ty~nlmxq2s.jpg?qXOoWo7_YJjVLK9jY_b4F',
    hero: 'https://www.rockstargames.com/VI/_next/static/media/meta.0t8ty~nlmxq2s.jpg?qXOoWo7_YJjVLK9jY_b4F',
    logo: 'https://upload.wikimedia.org/wikipedia/en/4/46/Grand_Theft_Auto_VI.png',
    preorder: true,
    // Countdown target (see releaseDateOf). Rockstar's own date, not a guess.
    releaseDate: '2026-11-19',
    releaseLabel: 'PS5 & Xbox Series X|S \u00b7 19 Nov 2026',
    officialUrl: 'https://www.rockstargames.com/VI',
    publisher: 'Rockstar Games'
  },
  {
    id: 'tes6',
    title: 'The Elder Scrolls VI',
    developer: 'Bethesda Game Studios',
    release: 2027,
    genre: 'RPG',
    tags: ['Open World', 'Fantasy', 'Pre-order'],
    price: 'TBA',
    size: 0,
    rating: 4.7,
    blurb: 'Bethesda\'s next single-player Elder Scrolls. Officially announced; no release date has been given yet.',
    colors: ['#2b3a55', '#c9a227'],
    steamAppId: null,
    // Bethesda has published no key art for TES VI — only the game's wordmark
    // and the announcement teaser frame. The wordmark is the cover (centred by
    // `artContain`) and the teaser still stands behind it as the banner, so the
    // card has a real image without inventing anything.
    cover: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/TESVI_logo_transparentbg-06.png/1280px-TESVI_logo_transparentbg-06.png',
    bannerImage: 'https://i.ytimg.com/vi/OkFdqqyI8y4/maxresdefault.jpg',
    wide: 'https://i.ytimg.com/vi/OkFdqqyI8y4/maxresdefault.jpg',
    hero: 'https://i.ytimg.com/vi/OkFdqqyI8y4/maxresdefault.jpg',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/TESVI_logo_transparentbg-06.png/1280px-TESVI_logo_transparentbg-06.png',
    artContain: true,
    preorder: true,
    releaseLabel: 'No release date yet',
    officialUrl: 'https://elderscrolls.bethesda.net/',
    publisher: 'Bethesda Softworks'
  }
];

// ---------------------------------------------------------------------------
// Console availability
// ---------------------------------------------------------------------------
/**
 * Which current-gen consoles each title is playable on, curated by hand.
 *
 * Steam and Epic only ever describe the PC release, and there is no key-less
 * API that honestly answers "is this on PS5 / Xbox Series X|S", so this is a
 * short hand-checked table rather than a guess. Only titles whose console
 * versions are public record are listed; a missing key means "unknown" and no
 * badge is drawn. `xbox` covers Xbox Series X|S, and backwards-compatible
 * titles count, because they genuinely are playable there.
 */
const CONSOLES = {
  gta5: ['ps5', 'xbox'],
  gta6: ['ps5', 'xbox'],
  rdr2: ['ps5', 'xbox'],
  cyberpunk: ['ps5', 'xbox'],
  witcher3: ['ps5', 'xbox'],
  eldenring: ['ps5', 'xbox'],
  bg3: ['ps5', 'xbox'],
  apex: ['ps5', 'xbox'],
  rocketleague: ['ps5', 'xbox'],
  pubg: ['ps5', 'xbox'],
  hollowknight: ['ps5', 'xbox'],
  spiderman: ['ps5'],            // PlayStation console exclusive
  'spiderman-miles': ['ps5'],    // PlayStation console exclusive
  kcd: ['ps5', 'xbox'],
  kcd2: ['ps5', 'xbox'],
  ds3: ['ps5', 'xbox'],
  stray: ['ps5', 'xbox'],
  eso: ['ps5', 'xbox'],
  terraria: ['ps5', 'xbox'],
  stardew: ['ps5', 'xbox'],
  amongus: ['ps5', 'xbox'],
  fortnite: ['ps5', 'xbox'],
  valorant: ['ps5', 'xbox'],
  warframe: ['ps5', 'xbox']
  // Deliberately absent (PC only): cs2, dota2, ultrakill.
};

for (const g of [...GAMES, ...UPCOMING]) {
  if (CONSOLES[g.id]) g.consoles = CONSOLES[g.id];
}

/** Every upcoming title (curated plus anything the live search flagged). */
const upcomingGames = () => UPCOMING;

const isUpcoming = (id) => UPCOMING.some((g) => g.id === id);

/** Where a pre-order for a game should actually be placed. */
function preorderUrl(id) {
  const g = byId(id);
  if (!g) return null;
  if (g.officialUrl) return g.officialUrl;
  if (g.steamAppId) return `https://store.steampowered.com/app/${g.steamAppId}/`;
  return null;
}

/** The stored pre-order record for a game, if the user put it on their list. */
const preorderRecord = (id) => (State.preorders && State.preorders[id]) || null;

/** True once a title has been added to the pre-order list. */
const isPreordered = (id) => !!preorderRecord(id);

/**
 * The ISO date to count down to, when one is known. Curated upcoming titles
 * carry their own; anything registered from a live store search kept whatever
 * date that store actually published. Returns null when there is no real date,
 * in which case no countdown is drawn rather than a made-up one.
 */
function releaseDateOf(id) {
  const g = byId(id) || {};
  const rec = preorderRecord(id);
  return g.releaseDate || (rec && rec.releaseDate) || null;
}

/** Pre-ordered titles, soonest release first (undated titles last, A–Z). */
function preorderedGames() {
  return Object.keys((typeof State !== 'undefined' && State.preorders) || {})
    .map(byId)
    .filter(Boolean)
    .sort((a, b) => {
      const ra = releaseDateOf(a.id);
      const rb = releaseDateOf(b.id);
      if (ra && rb) return ra < rb ? -1 : ra > rb ? 1 : 0;
      if (ra) return -1;
      if (rb) return 1;
      return String(a.title).localeCompare(String(b.title));
    });
}

// ---------------------------------------------------------------------------
// Game stores
// ---------------------------------------------------------------------------
/**
 * The storefronts Apex can hand a game over to. Detection reads each client's
 * own library database (see detect.js) so titles bought elsewhere show up here,
 * and `protocol` is the deep-link scheme used to launch one without knowing its
 * executable path.
 */
const STORES = [
  { id: 'steam', name: 'Steam', protocol: 'steam:', ico: 'gamepad' },
  { id: 'epic', name: 'Epic Games', protocol: 'com.epicgames.launcher:', ico: 'globe' },
  { id: 'gog', name: 'GOG Galaxy', protocol: 'goggalaxy:', ico: 'globe' },
  { id: 'ubisoft', name: 'Ubisoft Connect', protocol: 'uplay:', ico: 'globe' },
  { id: 'ea', name: 'EA App', protocol: 'link2ea:', ico: 'globe' },
  { id: 'battlenet', name: 'Battle.net', protocol: 'battle.net:', ico: 'globe' },
  { id: 'xbox', name: 'Xbox', protocol: 'msxbox:', ico: 'box' }
];

const storeById = (id) => STORES.find((s) => s.id === id) || null;
const storeName = (id) => (storeById(id) || {}).name || 'Store';

/** The Steam store page for a catalogue title (used by "Get on Steam"). */
function steamStoreUrl(id) {
  const g = byId(id);
  return g && g.steamAppId ? `https://store.steampowered.com/app/${g.steamAppId}/` : null;
}

/** Every game the user can see: the catalogue, the upcoming list and anything they added. */
function allGames() {
  const custom = (typeof State !== 'undefined' && Array.isArray(State.custom)) ? State.custom : [];
  return [...GAMES, ...UPCOMING, ...custom];
}

const byId = (id) => allGames().find((g) => g.id === id);
const isFree = (g) => g.price === 'Free';

// ---------------------------------------------------------------------------
// Ownership / installation
// ---------------------------------------------------------------------------
/** True when the game is really on this PC (detected) or was installed here. */
const isInstalled = (id) => !!(State.installed && State.installed[id]);

/**
 * True when the account actually owns the game. Ownership is verified against
 * the local Steam licence list, Epic manifests, the other store databases and
 * known on-disk data folders (see detect.js) — the launcher never offers to
 * download something the user does not have. Installing a game here also
 * implies ownership.
 */
const isOwned = (id) => !!(State.owned && State.owned[id]) || isInstalled(id);

/** Owned on this account but not installed on this PC yet. */
const isOwnedNotInstalled = (id) => isOwned(id) && !isInstalled(id);

/** Everything shown in the Library tab: the games actually installed. */
function installedGames() {
  return allGames().filter((g) => isInstalled(g.id));
}

/** Everything shown in the Store tab: curated titles not installed yet. */
function storeGames() {
  return CATALOG.map(byId).filter((g) => g && !isInstalled(g.id));
}

/** How the game came to be owned, for UI labels. */
function ownershipOf(id) {
  if (isInstalled(id)) return { kind: 'installed', label: 'Installed' };
  if (isOwned(id)) return { kind: 'owned', label: 'Owned' };
  return { kind: 'unowned', label: 'Not owned' };
}

/** Detection hint handed to the main process for matching. */
const gameHint = (g) => ({
  id: g.id,
  title: g.title,
  steamAppId: g.steamAppId || null,
  epicNames: g.epicNames || null,
  // GOG keys its registry install entries by product id, so declaring one here
  // gives an exact match instead of relying on the name comparison.
  gogIds: g.gogIds || null
});

// ---------------------------------------------------------------------------
// Install platform routing
// ---------------------------------------------------------------------------
/**
 * Which storefront actually performs this game's download. A store we detected
 * on disk wins, then the catalogue's own identifiers, and Apex's managed
 * installer is the fallback for custom and locally-linked titles.
 */
function platformOf(id) {
  const g = byId(id) || {};
  const link = (State.local && State.local.installs && State.local.installs[id]) || null;
  if (link && link.source && storeById(link.source)) return link.source;
  if (link && link.type === 'steam') return 'steam';
  if (link && link.type === 'epic') return 'epic';
  if (g.steamAppId) return 'steam';
  if (g.epicNames && g.epicNames.length) return 'epic';
  return 'apex';
}

/**
 * Pulls namespace/catalogId/appName back out of a stored Epic launch URI.
 * Epic encodes the three ids with a colon (%3A); some links use a literal
 * colon instead, so both are handled.
 */
function epicIdsFrom(uri) {
  const m = String(uri || '').match(/com\.epicgames\.launcher:\/\/apps\/([^?/]+)/);
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split(':').filter(Boolean);
  if (parts.length < 2) return null;
  return { namespace: parts[0], catalogId: parts[1], appName: parts[2] || null };
}

/**
 * Everything the installer needs: who downloads the game, what identifiers the
 * store needs, and whether Apex can start it automatically.
 */
function installPlan(id) {
  const g = byId(id) || {};
  const link = (State.local && State.local.installs && State.local.installs[id]) || null;
  const platform = platformOf(id);
  const store = storeById(platform);

  const plan = {
    id,
    title: g.title,
    size: g.size,
    platform,
    storeName: store ? store.name : 'Apex Launcher',
    ico: store ? store.ico : 'hardDrive',
    managed: platform === 'apex',
    appId: g.steamAppId || (link && link.appId) || null,
    namespace: null,
    catalogId: null,
    appName: null
  };

  if (platform === 'epic' && link && link.uri) {
    const ids = epicIdsFrom(link.uri);
    if (ids) { plan.namespace = ids.namespace; plan.catalogId = ids.catalogId; plan.appName = ids.appName; }
  }

  plan.canAutoInstall = platform === 'steam'
    ? !!plan.appId
    : platform === 'epic'
      ? !!(plan.namespace && plan.catalogId)
      : false;

  return plan;
}

/** "<drive>:\ApexGames\<Title>" — the folder an Apex-managed install lands in. */
function installPathOn(driveRoot, title) {
  const safe = String(title || 'Game').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Game';
  return `${String(driveRoot || 'C:').replace(/[\\/]+$/, '')}\\ApexGames\\${safe}`;
}

/** The folder this particular game will install into. */
function installDirFor(id) {
  if (State.installDirs && State.installDirs[id]) return State.installDirs[id];
  const g = byId(id) || {};
  const s = State.settings || {};
  const drive = s.installDrive || (s.installPath || 'C:\\').slice(0, 2);
  return installPathOn(drive, g.title);
}

// "0.5 GB" -> "512 MB" etc.
function fmtSize(gb) {
  if (!gb || gb < 0) return '\u2014';
  if (gb >= 1) return `${gb % 1 ? gb.toFixed(1) : gb} GB`;
  return `${Math.round(gb * 1024)} MB`;
}

/** Builds a new custom game record from a form payload. */
function makeCustomGame({ title, developer, genre, exe, imageUrl, colors, icon }) {
  const base = String(title || 'Custom Game').trim();
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'game';
  const id = `custom:${slug}-${Date.now().toString(36).slice(-4)}`;
  return {
    id,
    title: base,
    developer: developer || 'Local',
    release: new Date().getFullYear(),
    genre: genre || 'Custom',
    tags: ['Custom', 'Local'],
    size: 0,
    price: 'Free',
    rating: 0,
    blurb: exe ? `Locally linked executable: ${exe}` : 'Custom game added to your library.',
    colors: (colors && colors.length >= 2) ? colors : null,
    cover: imageUrl || null,
    hero: null,
    wide: null,
    // The icon Windows shows for the executable (see folder:scanGames).
    icon: icon || null,
    custom: true
  };
}
