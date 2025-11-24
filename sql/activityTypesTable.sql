CREATE TABLE `activityTypes` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `typeName` varchar(255) NOT NULL,
  `folderName` varchar(255) NOT NULL,
  -- `requiresBrand` tinyint(1) DEFAULT 0,
  -- `requiresCamp` tinyint(1) DEFAULT 0,
  `activitySpecificFields` json DEFAULT NULL,
  `isActive` tinyint(1) DEFAULT 1,
  `displayOrder` int DEFAULT 0,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `typeName` (`typeName`),
  KEY `idx_isActive` (`isActive`),
  KEY `idx_displayOrder` (`displayOrder`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Insert default activity types
-- Note: requiresBrand and requiresCamp columns are commented out in the table definition
-- INSERT INTO `activityTypes` (`id`, `typeName`, `folderName`, `isActive`, `displayOrder`) VALUES
-- (uuid(), 'prescription', 'prescriptions', 1, 1),
-- (uuid(), 'pob', 'pob', 1, 2),
-- (uuid(), 'camp', 'camps', 1, 3);

