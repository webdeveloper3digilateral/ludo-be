CREATE TABLE `admins` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `adminId` varchar(255) NOT NULL,
  `adminName` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `gender` varchar(255) DEFAULT NULL,
  `phone` varchar(12) DEFAULT NULL,
  `status` varchar(255) DEFAULT 'Active',
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `adminId` (`adminId`),
  KEY `idx_createdAt` (`createdAt`),
  KEY `idx_phone` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci