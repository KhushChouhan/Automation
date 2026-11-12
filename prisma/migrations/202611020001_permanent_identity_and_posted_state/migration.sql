-- Existing rows remain untouched. Once assigned, source identities are permanent.
CREATE FUNCTION protect_video_identity_and_posted_state() RETURNS trigger AS $$
BEGIN
  IF NEW."videoId" IS DISTINCT FROM OLD."videoId" OR
     (OLD."driveFileId" IS NOT NULL AND NEW."driveFileId" IS DISTINCT FROM OLD."driveFileId") THEN
    RAISE EXCEPTION 'Assigned video and Drive identities are immutable';
  END IF;
  IF OLD."workflowStatus" = 'POSTED' AND NEW."workflowStatus" <> 'POSTED' THEN
    RAISE EXCEPTION 'Posted video state is terminal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Video_identity_and_posted_state"
BEFORE UPDATE OF "videoId", "driveFileId", "workflowStatus" ON "Video"
FOR EACH ROW EXECUTE FUNCTION protect_video_identity_and_posted_state();

CREATE FUNCTION protect_posted_schedule() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'POSTED' AND NEW.status <> 'POSTED' THEN
    RAISE EXCEPTION 'Posted schedule state is terminal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Schedule_posted_state"
BEFORE UPDATE OF "status" ON "Schedule"
FOR EACH ROW EXECUTE FUNCTION protect_posted_schedule();
