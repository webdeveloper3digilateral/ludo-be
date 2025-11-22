CREATE TABLE `camps` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `campName` varchar(255) NOT NULL,
  `defaultFactor` int DEFAULT '1',
  `points` int DEFAULT '0',
  `hearts` int DEFAULT NULL,
  `diceRolls` int DEFAULT NULL,
  `createdAt` datetime DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `campName` (`campName`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci


INSERT INTO `camps` (`id`, `campName`, `defaultFactor`, `points`) VALUES
(uuid(), 'Diabetes Camp', 1, 0),
(uuid(), 'Uric Acid Camp', 1, 0);

