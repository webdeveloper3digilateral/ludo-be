CREATE TABLE `moveAdjustmentConfigs` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `medianValue` int NOT NULL,
  `lessMedianFactor` decimal(10,4) NOT NULL,
  `greaterMedianFactor` decimal(10,4) NOT NULL,
  `pointToDiceRollRatio` int DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_createdAt` (`createdAt` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci